import https from 'node:https';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const SYSTEM_PROMPT = {
  type: 'text',
  text: "You are Claude Code, Anthropic's official CLI for Claude.",
};

export function createProxy(config, logger, tokenManager) {

  function stripTtlFromCacheControl(body) {
    if (!config.strip_ttl || !body || typeof body !== 'object') return body;

    const process = (arr) => {
      if (!Array.isArray(arr)) return;
      for (const item of arr) {
        if (item?.cache_control?.ttl !== undefined) {
          delete item.cache_control.ttl;
          logger.debug('Removed ttl from cache_control');
        }
      }
    };

    if (Array.isArray(body.system)) process(body.system);
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (Array.isArray(msg.content)) process(msg.content);
      }
    }
    return body;
  }

  function filterSamplingParams(body) {
    if (!config.filter_sampling_params || !body || typeof body !== 'object') return body;

    const hasTemp = body.temperature !== undefined;
    const hasTopP = body.top_p !== undefined;

    if (hasTemp && hasTopP) {
      const tempDefault = body.temperature === 1.0;
      const topPDefault = body.top_p === 1.0;

      if (tempDefault && topPDefault) {
        delete body.top_p;
      } else if (topPDefault) {
        delete body.top_p;
      } else if (tempDefault) {
        delete body.temperature;
      } else {
        delete body.top_p; // prefer temperature
      }
      logger.debug('Filtered duplicate sampling parameters');
    } else if (hasTopP && body.top_p === 1.0) {
      delete body.top_p;
    } else if (hasTemp && body.temperature === 1.0) {
      delete body.temperature;
    }

    return body;
  }

  function processRequestBody(body) {
    if (!body) return body;

    // Prepend required system prompt
    if (body.system) {
      if (Array.isArray(body.system)) {
        body.system.unshift(SYSTEM_PROMPT);
      } else {
        body.system = [SYSTEM_PROMPT, { type: 'text', text: body.system }];
      }
    } else {
      body.system = [SYSTEM_PROMPT];
    }

    stripTtlFromCacheControl(body);
    filterSamplingParams(body);
    return body;
  }

  function buildHeaders(token) {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': token,
      'anthropic-version': API_VERSION,
      'User-Agent': 'claude-code-pxy/1.0.0',
    };
    if (config.beta_header) {
      headers['anthropic-beta'] = config.beta_header;
    }
    return headers;
  }

  function makeRequest(processedBody, token) {
    const url = new URL(API_URL);
    const payload = JSON.stringify(processedBody);

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: buildHeaders(token),
      }, resolve);

      req.on('error', (err) => { req.destroy(); reject(err); });
      req.write(payload);
      req.end();
    });
  }

  function extractSSEText(chunk) {
    try {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = JSON.parse(line.substring(6));
          if (data.type === 'content_block_delta') {
            if (data.delta?.type === 'text_delta') return { text: data.delta.text };
            if (data.delta?.type === 'thinking_delta') return { thinking: data.delta.thinking };
          }
        }
      }
    } catch { /* ignore parse errors in SSE chunks */ }
    return null;
  }

  function streamResponse(clientRes, apiRes) {
    const contentType = apiRes.headers['content-type'] || '';

    if (contentType.includes('text/event-stream')) {
      logger.debug('Outgoing response headers:', JSON.stringify(clientRes.getHeaders(), null, 2));

      apiRes.on('error', (err) => {
        logger.debug('Upstream stream error:', err.message);
        if (!clientRes.headersSent) clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        if (!clientRes.destroyed) clientRes.end(JSON.stringify({ error: 'Upstream response error' }));
      });

      clientRes.on('close', () => {
        logger.debug('Client disconnected');
        if (!apiRes.destroyed) apiRes.destroy();
      });

      if (logger.level >= 3) {
        const debugStream = logger.createDebugStream('Claude SSE', extractSSEText);
        debugStream.on('error', (err) => {
          logger.debug('Debug stream error:', err.message);
          if (!clientRes.destroyed) clientRes.end();
        });
        apiRes.pipe(debugStream).pipe(clientRes);
        debugStream.on('end', () => logger.debug('\nStreaming response complete'));
      } else {
        apiRes.pipe(clientRes);
        apiRes.on('end', () => logger.debug('Streaming response complete'));
      }
    } else {
      // Non-streaming: buffer and forward
      clientRes.removeHeader('content-encoding');
      let data = '';
      apiRes.on('data', (chunk) => { data += chunk; });
      apiRes.on('error', (err) => {
        logger.error('Upstream non-streaming error:', err.message);
        if (!clientRes.headersSent) clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        if (!clientRes.destroyed) clientRes.end(JSON.stringify({ error: 'Upstream error' }));
      });
      apiRes.on('end', () => {
        logger.debug(`Non-streaming response (${apiRes.statusCode}): ${data.substring(0, 500)}`);
        try {
          const json = JSON.parse(data);
          clientRes.setHeader('Content-Type', 'application/json');
          clientRes.end(JSON.stringify(json));
        } catch {
          clientRes.end(data);
        }
      });
    }
  }

  async function handleRequest(clientRes, body) {
    try {
      const processedBody = processRequestBody(body);
      const token = await tokenManager.getValidToken();

      logger.debug('Outgoing request body:', processedBody);

      let apiRes = await makeRequest(processedBody, token);

      // 401 retry: refresh token and try once more
      if (apiRes.statusCode === 401) {
        logger.info('Got 401, refreshing token...');
        // Drain the failed response
        apiRes.resume();
        tokenManager.clearCachedToken();
        const newToken = await tokenManager.getValidToken();
        apiRes = await makeRequest(processedBody, newToken);
        logger.debug(`Retry status: ${apiRes.statusCode}`);
      }

      clientRes.statusCode = apiRes.statusCode;
      for (const [key, value] of Object.entries(apiRes.headers)) {
        clientRes.setHeader(key, value);
      }
      streamResponse(clientRes, apiRes);
    } catch (err) {
      logger.error('Proxy error:', err.message);
      if (!clientRes.headersSent) clientRes.writeHead(500, { 'Content-Type': 'application/json' });
      if (!clientRes.destroyed) clientRes.end(JSON.stringify({ error: err.message }));
    }
  }

  return {
    processRequestBody,
    handleRequest,
    // Exposed for testing
    stripTtlFromCacheControl,
    filterSamplingParams,
  };
}
