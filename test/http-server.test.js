import { jest } from '@jest/globals';
import http from 'node:http';
import { createHttpServer, escapeHtml } from '../src/http-server.js';

function makeLogger() {
  return {
    level: 2,
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  };
}

function makeOAuthManager() {
  const handler = jest.fn(async (pathname, method, query, res) => {
    if (pathname === '/auth/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ authenticated: false }));
      return true;
    }
    return false;
  });
  return { getRouteHandler: () => handler };
}

function makeProxy() {
  return {
    handleRequest: jest.fn(async (res, body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, model: body.model }));
    }),
  };
}

function makeConfig(overrides = {}) {
  return {
    port: 0, // random port
    resolvedHost: '127.0.0.1',
    max_body_bytes: 10_000_000,
    ...overrides,
  };
}

function request(server, method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.server.address();
    const options = {
      hostname: addr.address,
      port: addr.port,
      path,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, body: data }); }
      });
    });

    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

describe('createHttpServer', () => {
  let httpServer;

  afterEach(async () => {
    if (httpServer) await httpServer.close().catch(() => {});
    httpServer = null;
  });

  test('/health returns ok', async () => {
    httpServer = createHttpServer(makeConfig(), makeLogger(), makeOAuthManager(), makeProxy());
    await httpServer.listen();
    const res = await request(httpServer, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.server).toBe('claude-code-pxy');
  });

  test('OPTIONS returns CORS headers', async () => {
    httpServer = createHttpServer(makeConfig(), makeLogger(), makeOAuthManager(), makeProxy());
    await httpServer.listen();
    const res = await request(httpServer, 'OPTIONS', '/v1/messages');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });

  test('unknown path returns 404', async () => {
    httpServer = createHttpServer(makeConfig(), makeLogger(), makeOAuthManager(), makeProxy());
    await httpServer.listen();
    const res = await request(httpServer, 'GET', '/unknown');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });

  test('/auth/* routes delegate to oauth handler', async () => {
    httpServer = createHttpServer(makeConfig(), makeLogger(), makeOAuthManager(), makeProxy());
    await httpServer.listen();
    const res = await request(httpServer, 'GET', '/auth/status');
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(false);
  });

  test('POST /v1/messages delegates to proxy', async () => {
    const proxy = makeProxy();
    httpServer = createHttpServer(makeConfig(), makeLogger(), makeOAuthManager(), proxy);
    await httpServer.listen();
    const res = await request(httpServer, 'POST', '/v1/messages', { model: 'claude-sonnet-4-20250514', messages: [] });
    expect(res.status).toBe(200);
    expect(proxy.handleRequest).toHaveBeenCalled();
  });

  test('oversized body returns 413', async () => {
    httpServer = createHttpServer(makeConfig({ max_body_bytes: 10 }), makeLogger(), makeOAuthManager(), makeProxy());
    await httpServer.listen();
    const res = await request(httpServer, 'POST', '/v1/messages', { model: 'x'.repeat(100) });
    expect(res.status).toBe(413);
  });

  test('invalid JSON returns 400', async () => {
    httpServer = createHttpServer(makeConfig(), makeLogger(), makeOAuthManager(), makeProxy());
    await httpServer.listen();
    const res = await request(httpServer, 'POST', '/v1/messages', 'not-json');
    expect(res.status).toBe(400);
  });

  test('CORS headers present on all responses', async () => {
    httpServer = createHttpServer(makeConfig(), makeLogger(), makeOAuthManager(), makeProxy());
    await httpServer.listen();
    const res = await request(httpServer, 'GET', '/health');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});

describe('escapeHtml', () => {
  test('escapes HTML special characters', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  test('escapes ampersand', () => {
    expect(escapeHtml('a&b')).toBe('a&amp;b');
  });

  test('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });
});
