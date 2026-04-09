import http from 'node:http';

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.resume(); // drain remaining data
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) { resolve({}); return; }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(Object.assign(new Error(`Invalid JSON: ${err.message}`), { statusCode: 400 }));
      }
    });

    req.on('error', reject);
  });
}

function getClientIP(req) {
  return req.headers['x-forwarded-for']
    || req.headers['x-real-ip']
    || req.connection?.remoteAddress
    || '127.0.0.1';
}

export function createHttpServer(config, logger, oauthManager, proxy) {
  const oauthRouteHandler = oauthManager.getRouteHandler();

  async function handleRequest(req, res) {
    const clientIP = getClientIP(req);
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method;

    logger.info(`${method} ${pathname} from ${clientIP}`);

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, x-api-key, anthropic-version');

    if (method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // OAuth routes
    if (pathname.startsWith('/auth/')) {
      const query = Object.fromEntries(url.searchParams);
      const handled = await oauthRouteHandler(pathname, method, query, res);
      if (handled) return;
    }

    // Health check
    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', server: 'claude-code-pxy', timestamp: Date.now() }));
      return;
    }

    // API proxy: POST /v1/messages
    if (method === 'POST' && pathname === '/v1/messages') {
      try {
        // Check for API key in header
        const apiKey = req.headers['x-api-key'];
        if (apiKey) proxy._setApiKey?.(apiKey);

        const body = await parseBody(req, config.max_body_bytes);
        logger.debug(`Request body (${JSON.stringify(body).length} bytes)`);
        await proxy.handleRequest(res, body);
      } catch (err) {
        const status = err.statusCode || 500;
        logger.error(`Request error (${status}):`, err.message);
        if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json' });
        if (!res.destroyed) res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  const server = http.createServer(handleRequest);

  return {
    server,

    listen() {
      return new Promise((resolve) => {
        server.listen(config.port, config.resolvedHost, () => {
          logger.info(`Server listening on ${config.resolvedHost}:${config.port}`);
          resolve();
        });
      });
    },

    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
    },
  };
}
