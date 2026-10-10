import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { createOAuthManager } from '../src/oauth.js';

function makeLogger() {
  return {
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
  };
}

function makeTokenManager() {
  return {
    saveTokens: jest.fn(),
    loadTokens: jest.fn(() => null),
    deleteTokens: jest.fn(),
    isAuthenticated: jest.fn(() => false),
    getTokenExpiration: jest.fn(() => null),
    getAuthStatus: jest.fn(() => ({ usable: false, source: null, state: 'none', expires_at: null })),
    logout: jest.fn(),
  };
}

function makeConfig() {
  return { auto_open_browser: false, publicBaseUrl: 'http://localhost:42069' };
}

describe('createOAuthManager', () => {
  describe('PKCE', () => {
    test('generatePKCE returns verifier, challenge, and state', () => {
      const oauth = createOAuthManager(makeConfig(), makeLogger(), makeTokenManager());
      const pkce = oauth.generatePKCE();
      expect(pkce.code_verifier).toBeDefined();
      expect(pkce.code_challenge).toBeDefined();
      expect(pkce.state).toBeDefined();
      expect(pkce.code_verifier.length).toBeGreaterThanOrEqual(43);
      expect(pkce.state.length).toBeGreaterThanOrEqual(43);
    });

    test('code_challenge is SHA256 of code_verifier', () => {
      const oauth = createOAuthManager(makeConfig(), makeLogger(), makeTokenManager());
      const pkce = oauth.generatePKCE();
      const expected = createHash('sha256').update(pkce.code_verifier).digest('base64url');
      expect(pkce.code_challenge).toBe(expected);
    });

    test('generates unique values each call', () => {
      const oauth = createOAuthManager(makeConfig(), makeLogger(), makeTokenManager());
      const a = oauth.generatePKCE();
      const b = oauth.generatePKCE();
      expect(a.code_verifier).not.toBe(b.code_verifier);
      expect(a.state).not.toBe(b.state);
    });
  });

  describe('buildAuthorizationURL', () => {
    test('contains required parameters', () => {
      const oauth = createOAuthManager(makeConfig(), makeLogger(), makeTokenManager());
      const pkce = oauth.generatePKCE();
      const url = oauth.buildAuthorizationURL(pkce);
      expect(url).toContain('https://claude.ai/oauth/authorize');
      expect(url).toContain('client_id=');
      expect(url).toContain('response_type=code');
      expect(url).toContain('code_challenge_method=S256');
      expect(url).toContain(`code_challenge=${pkce.code_challenge}`);
      expect(url).toContain(`state=${pkce.state}`);
    });
  });

  describe('PKCE state management', () => {
    test('store and retrieve state', () => {
      const oauth = createOAuthManager(makeConfig(), makeLogger(), makeTokenManager());
      const pkce = oauth.generatePKCE();
      oauth.storePKCEState(pkce);
      const retrieved = oauth.getPKCEState(pkce.state);
      expect(retrieved).not.toBeNull();
      expect(retrieved.code_verifier).toBe(pkce.code_verifier);
      expect(retrieved.created_at).toBeDefined();
    });

    test('returns null for unknown state', () => {
      const oauth = createOAuthManager(makeConfig(), makeLogger(), makeTokenManager());
      expect(oauth.getPKCEState('unknown')).toBeNull();
    });

    test('delete state prevents retrieval', () => {
      const oauth = createOAuthManager(makeConfig(), makeLogger(), makeTokenManager());
      const pkce = oauth.generatePKCE();
      oauth.storePKCEState(pkce);
      oauth.deletePKCEState(pkce.state);
      expect(oauth.getPKCEState(pkce.state)).toBeNull();
    });
  });

  describe('cleanup interval', () => {
    test('startCleanupInterval returns interval and stopCleanupInterval clears it', () => {
      const oauth = createOAuthManager(makeConfig(), makeLogger(), makeTokenManager());
      const interval = oauth.startCleanupInterval();
      expect(interval).toBeDefined();
      // Should not throw
      oauth.stopCleanupInterval();
    });

    test('stopCleanupInterval is safe to call without start', () => {
      const oauth = createOAuthManager(makeConfig(), makeLogger(), makeTokenManager());
      expect(() => oauth.stopCleanupInterval()).not.toThrow();
    });
  });

  describe('route handler', () => {
    function mockRes() {
      const res = {
        writeHead: jest.fn(),
        end: jest.fn(),
        statusCode: 200,
      };
      return res;
    }

    test('/auth/status returns unauthenticated state', async () => {
      const tm = makeTokenManager();
      const oauth = createOAuthManager(makeConfig(), makeLogger(), tm);
      const handler = oauth.getRouteHandler();
      const res = mockRes();
      const handled = await handler('/auth/status', 'GET', {}, res);
      expect(handled).toBe(true);
      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      const body = JSON.parse(res.end.mock.calls[0][0]);
      expect(body.authenticated).toBe(false);
      expect(body.expires_at).toBeNull();
      expect(body.state).toBe('none');
      expect(body.login_url).toBe('http://localhost:42069/auth/login');
    });

    test('/auth/logout calls tokenManager.logout', async () => {
      const tm = makeTokenManager();
      const oauth = createOAuthManager(makeConfig(), makeLogger(), tm);
      const handler = oauth.getRouteHandler();
      const res = mockRes();
      const handled = await handler('/auth/logout', 'GET', {}, res);
      expect(handled).toBe(true);
      expect(tm.logout).toHaveBeenCalled();
    });

    test('/auth/get-url returns authorization URL', async () => {
      const tm = makeTokenManager();
      const oauth = createOAuthManager(makeConfig(), makeLogger(), tm);
      const handler = oauth.getRouteHandler();
      const res = mockRes();
      const handled = await handler('/auth/get-url', 'GET', {}, res);
      expect(handled).toBe(true);
      const body = JSON.parse(res.end.mock.calls[0][0]);
      expect(body.url).toContain('https://claude.ai/oauth/authorize');
      expect(body.state).toBeDefined();
    });

    test('/auth/callback rejects invalid state', async () => {
      const tm = makeTokenManager();
      const oauth = createOAuthManager(makeConfig(), makeLogger(), tm);
      const handler = oauth.getRouteHandler();
      const res = mockRes();
      const handled = await handler('/auth/callback', 'GET', { code: 'c', state: 'bad' }, res);
      expect(handled).toBe(true);
      expect(res.writeHead).toHaveBeenCalledWith(500, { 'Content-Type': 'text/html' });
    });

    test('unhandled path returns false', async () => {
      const oauth = createOAuthManager(makeConfig(), makeLogger(), makeTokenManager());
      const handler = oauth.getRouteHandler();
      const res = mockRes();
      const handled = await handler('/unknown', 'GET', {}, res);
      expect(handled).toBe(false);
    });
  });
});
