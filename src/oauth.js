import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const __dirname = dirname(fileURLToPath(import.meta.url));

const OAUTH_CONFIG = {
  client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorize_url: 'https://claude.ai/oauth/authorize',
  token_url: 'https://console.anthropic.com/v1/oauth/token',
  redirect_uri: 'https://console.anthropic.com/oauth/code/callback',
  scope: 'org:create_api_key user:profile user:inference',
};

const PKCE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

export function createOAuthManager(config, logger, tokenManager) {
  const pkceStates = new Map();
  let cleanupInterval = null;

  // --- PKCE ---

  function generatePKCE() {
    const code_verifier = randomBytes(32).toString('base64url');
    const code_challenge = createHash('sha256').update(code_verifier).digest('base64url');
    const state = randomBytes(32).toString('base64url');
    return { code_verifier, code_challenge, state };
  }

  function buildAuthorizationURL(pkce) {
    const params = new URLSearchParams({
      code: 'true',
      client_id: OAUTH_CONFIG.client_id,
      response_type: 'code',
      redirect_uri: OAUTH_CONFIG.redirect_uri,
      scope: OAUTH_CONFIG.scope,
      code_challenge: pkce.code_challenge,
      code_challenge_method: 'S256',
      state: pkce.state,
    });
    return `${OAUTH_CONFIG.authorize_url}?${params.toString()}`;
  }

  function storePKCEState(pkce) {
    pkceStates.set(pkce.state, {
      code_verifier: pkce.code_verifier,
      created_at: Date.now(),
    });
  }

  function getPKCEState(state) {
    return pkceStates.get(state) || null;
  }

  function deletePKCEState(state) {
    pkceStates.delete(state);
  }

  function cleanupExpiredPKCE() {
    const now = Date.now();
    for (const [state, data] of pkceStates.entries()) {
      if (now - data.created_at > PKCE_EXPIRY_MS) {
        pkceStates.delete(state);
      }
    }
  }

  function startCleanupInterval() {
    cleanupInterval = setInterval(cleanupExpiredPKCE, 60_000);
    return cleanupInterval;
  }

  function stopCleanupInterval() {
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
    }
  }

  // --- Token exchange ---

  async function exchangeCodeForTokens(code, codeVerifier, state) {
    const payload = JSON.stringify({
      grant_type: 'authorization_code',
      code,
      state,
      client_id: OAUTH_CONFIG.client_id,
      code_verifier: codeVerifier,
      redirect_uri: OAUTH_CONFIG.redirect_uri,
    });

    const url = new URL(OAUTH_CONFIG.token_url);

    const response = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); }
            catch { reject(new Error(`Invalid token response: ${data}`)); }
          } else {
            reject(new Error(`Token exchange failed (${res.statusCode}): ${data}`));
          }
        });
      });

      req.setTimeout(10_000, () => { req.destroy(); reject(new Error('Token exchange timeout')); });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    const tokens = {
      access_token: response.access_token,
      refresh_token: response.refresh_token,
      expires_at: Date.now() + (response.expires_in * 1000),
    };
    tokenManager.saveTokens(tokens);
    logger.info('OAuth authentication successful');
    return tokens;
  }

  // --- Static file serving ---

  function serveStaticFile(res, filename, contentType) {
    try {
      const data = readFileSync(join(__dirname, 'static', filename), 'utf8');
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // --- Route handler ---

  function getRouteHandler() {
    return async (pathname, method, query, res) => {
      if (pathname === '/auth/login' && method === 'GET') {
        serveStaticFile(res, 'login.html', 'text/html');
        return true;
      }

      if (pathname === '/auth/get-url' && method === 'GET') {
        try {
          const pkce = generatePKCE();
          storePKCEState(pkce);
          const authUrl = buildAuthorizationURL(pkce);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ url: authUrl, state: pkce.state }));
          logger.info('Generated OAuth authorization URL');
        } catch (err) {
          logger.error('OAuth get-url error:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to generate OAuth URL' }));
        }
        return true;
      }

      if (pathname === '/auth/callback' && method === 'GET') {
        try {
          let code = query.code;
          let state = query.state;

          // Manual code entry: "code#state"
          if (query.manual_code) {
            const parts = query.manual_code.split('#');
            if (parts.length !== 2) throw new Error('Invalid code format. Expected: code#state');
            code = parts[0];
            state = parts[1];
          }

          if (!code || !state) throw new Error('Missing authorization code or state');

          const pkceData = getPKCEState(state);
          if (!pkceData) throw new Error('Invalid or expired state parameter. Please start again.');

          deletePKCEState(state);
          await exchangeCodeForTokens(code, pkceData.code_verifier, state);
          serveStaticFile(res, 'callback.html', 'text/html');
        } catch (err) {
          logger.error('OAuth callback error:', err.message);
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(`<!DOCTYPE html><html><head><title>Authentication Failed</title></head>
<body><h1>Authentication Failed</h1><p>Error: ${escapeHtml(err.message)}</p>
<p><a href="/auth/login">Try again</a></p></body></html>`);
        }
        return true;
      }

      if (pathname === '/auth/status' && method === 'GET') {
        const status = tokenManager.getAuthStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          authenticated: status.usable,
          state: status.state,
          source: status.source,
          expires_at: status.expires_at ? status.expires_at.toISOString() : null,
          login_url: `${config.publicBaseUrl}/auth/login`,
        }));
        return true;
      }

      if (pathname === '/auth/logout' && method === 'GET') {
        try {
          tokenManager.logout();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Logged out successfully' }));
          logger.info('User logged out');
        } catch (err) {
          logger.error('Logout error:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to logout' }));
        }
        return true;
      }

      return false; // not handled
    };
  }

  return {
    generatePKCE,
    buildAuthorizationURL,
    storePKCEState,
    getPKCEState,
    deletePKCEState,
    exchangeCodeForTokens,
    startCleanupInterval,
    stopCleanupInterval,
    getRouteHandler,
  };
}
