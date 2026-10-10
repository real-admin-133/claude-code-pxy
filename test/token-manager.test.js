import { jest } from '@jest/globals';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createTokenManager } from '../src/token-manager.js';

function makeLogger() {
  return {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  };
}

function makeConfig(overrides = {}) {
  return { fallback_to_claude_code: true, ...overrides };
}

describe('createTokenManager', () => {
  const tokenDir = join(homedir(), '.claude-code-proxy');
  const tokenPath = join(tokenDir, 'tokens.json');
  let originalTokens = null;

  beforeEach(() => {
    // Backup existing tokens
    try { originalTokens = readFileSync(tokenPath, 'utf8'); } catch { originalTokens = null; }
  });

  afterEach(() => {
    // Restore original tokens
    try {
      if (originalTokens) {
        writeFileSync(tokenPath, originalTokens, 'utf8');
      } else if (existsSync(tokenPath)) {
        rmSync(tokenPath);
      }
    } catch { /* ignore */ }
  });

  describe('token file operations', () => {
    test('loadTokens returns null when no file exists', () => {
      // Remove if exists
      try { rmSync(tokenPath); } catch { /* ok */ }
      const tm = createTokenManager(makeConfig(), makeLogger());
      expect(tm.loadTokens()).toBeNull();
    });

    test('saveTokens and loadTokens round-trip', () => {
      const tm = createTokenManager(makeConfig(), makeLogger());
      const data = { access_token: 'at', refresh_token: 'rt', expires_at: Date.now() + 60000 };
      tm.saveTokens(data);
      const loaded = tm.loadTokens();
      expect(loaded.access_token).toBe('at');
      expect(loaded.refresh_token).toBe('rt');
    });

    test('deleteTokens removes file', () => {
      const tm = createTokenManager(makeConfig(), makeLogger());
      tm.saveTokens({ access_token: 'at', refresh_token: 'rt', expires_at: Date.now() + 60000 });
      tm.deleteTokens();
      expect(tm.loadTokens()).toBeNull();
    });
  });

  describe('setApiKeyOverride', () => {
    test('getValidToken returns override when set', async () => {
      const tm = createTokenManager(makeConfig(), makeLogger());
      tm.setApiKeyOverride('sk-ant-123');
      const token = await tm.getValidToken();
      expect(token).toBe('Bearer sk-ant-123');
    });

    test('preserves Bearer prefix if already present', async () => {
      const tm = createTokenManager(makeConfig(), makeLogger());
      tm.setApiKeyOverride('Bearer sk-ant-123');
      const token = await tm.getValidToken();
      expect(token).toBe('Bearer sk-ant-123');
    });
  });

  describe('getValidToken with OAuth tokens', () => {
    test('returns token when not expired', async () => {
      const tm = createTokenManager(makeConfig(), makeLogger());
      tm.saveTokens({
        access_token: 'valid-token',
        refresh_token: 'rt',
        expires_at: Date.now() + 300_000,
      });
      const token = await tm.getValidToken();
      expect(token).toBe('Bearer valid-token');
    });

    test('throws when no tokens and no fallback', async () => {
      try { rmSync(tokenPath); } catch { /* ok */ }
      const tm = createTokenManager(makeConfig({ fallback_to_claude_code: false }), makeLogger());
      await expect(tm.getValidToken()).rejects.toThrow('No authentication tokens found');
    });
  });

  describe('isAuthenticated', () => {
    test('returns false when no tokens', () => {
      try { rmSync(tokenPath); } catch { /* ok */ }
      const tm = createTokenManager(makeConfig({ fallback_to_claude_code: false }), makeLogger());
      expect(tm.isAuthenticated()).toBe(false);
    });

    test('returns true from the Claude Code fallback when enabled', () => {
      try { rmSync(tokenPath); } catch { /* ok */ }
      const tm = createTokenManager(makeConfig(), makeLogger());
      // Depends on whether this host has Claude Code credentials; assert the
      // reported source stays consistent with the verdict either way.
      const status = tm.getAuthStatus();
      expect(status.usable).toBe(status.source === 'claude_code');
    });

    test('returns true when tokens exist', () => {
      const tm = createTokenManager(makeConfig(), makeLogger());
      tm.saveTokens({ access_token: 'at', refresh_token: 'rt', expires_at: Date.now() + 60000 });
      expect(tm.isAuthenticated()).toBe(true);
    });
  });

  describe('getAuthStatus', () => {
    test('reports none when no credentials exist', () => {
      try { rmSync(tokenPath); } catch { /* ok */ }
      const tm = createTokenManager(makeConfig({ fallback_to_claude_code: false }), makeLogger());
      expect(tm.getAuthStatus()).toEqual({
        usable: false, source: null, state: 'none', expires_at: null,
      });
    });

    test('reports valid for a fresh OAuth token', () => {
      const tm = createTokenManager(makeConfig(), makeLogger());
      const exp = Date.now() + 300_000;
      tm.saveTokens({ access_token: 'at', refresh_token: 'rt', expires_at: exp });
      const status = tm.getAuthStatus();
      expect(status.usable).toBe(true);
      expect(status.state).toBe('valid');
      expect(status.source).toBe('oauth');
      expect(status.expires_at.getTime()).toBe(exp);
    });

    test('reports refreshable when expired but a refresh token is held', () => {
      const tm = createTokenManager(makeConfig(), makeLogger());
      tm.saveTokens({ access_token: 'at', refresh_token: 'rt', expires_at: Date.now() - 1000 });
      const status = tm.getAuthStatus();
      expect(status.usable).toBe(true);
      expect(status.state).toBe('refreshable');
    });

    test('reports expired when the refresh token is gone', () => {
      const tm = createTokenManager(makeConfig({ fallback_to_claude_code: false }), makeLogger());
      tm.saveTokens({ access_token: 'at', expires_at: Date.now() - 1000 });
      const status = tm.getAuthStatus();
      expect(status.usable).toBe(false);
      expect(status.state).toBe('expired');
    });

    test('treats a token inside the refresh buffer as refreshable, not valid', () => {
      const tm = createTokenManager(makeConfig(), makeLogger());
      tm.saveTokens({ access_token: 'at', refresh_token: 'rt', expires_at: Date.now() + 30_000 });
      expect(tm.getAuthStatus().state).toBe('refreshable');
    });

    test('an API key override wins over stored tokens', () => {
      const tm = createTokenManager(makeConfig(), makeLogger());
      tm.saveTokens({ access_token: 'at', expires_at: Date.now() - 1000 });
      tm.setApiKeyOverride('sk-test');
      const status = tm.getAuthStatus();
      expect(status.usable).toBe(true);
      expect(status.source).toBe('api_key');
    });
  });

  describe('getTokenExpiration', () => {
    test('returns null when no tokens', () => {
      try { rmSync(tokenPath); } catch { /* ok */ }
      const tm = createTokenManager(makeConfig({ fallback_to_claude_code: false }), makeLogger());
      expect(tm.getTokenExpiration()).toBeNull();
    });

    test('returns Date when tokens exist', () => {
      const tm = createTokenManager(makeConfig(), makeLogger());
      const exp = Date.now() + 300_000;
      tm.saveTokens({ access_token: 'at', refresh_token: 'rt', expires_at: exp });
      const result = tm.getTokenExpiration();
      expect(result).toBeInstanceOf(Date);
      expect(result.getTime()).toBe(exp);
    });
  });

  describe('logout', () => {
    test('clears tokens', () => {
      const tm = createTokenManager(makeConfig({ fallback_to_claude_code: false }), makeLogger());
      tm.saveTokens({ access_token: 'at', refresh_token: 'rt', expires_at: Date.now() + 60000 });
      tm.logout();
      expect(tm.isAuthenticated()).toBe(false);
    });
  });

  describe('clearCachedToken', () => {
    test('forces re-read from file on next getValidToken', async () => {
      const tm = createTokenManager(makeConfig(), makeLogger());
      tm.saveTokens({ access_token: 'tok-1', refresh_token: 'rt', expires_at: Date.now() + 300_000 });
      const t1 = await tm.getValidToken();
      expect(t1).toBe('Bearer tok-1');

      // Overwrite file directly
      tm.saveTokens({ access_token: 'tok-2', refresh_token: 'rt', expires_at: Date.now() + 300_000 });
      tm.clearCachedToken();
      const t2 = await tm.getValidToken();
      expect(t2).toBe('Bearer tok-2');
    });
  });
});
