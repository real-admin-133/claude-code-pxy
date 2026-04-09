import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';
import https from 'node:https';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const REFRESH_BUFFER_MS = 60_000; // refresh 1 minute before expiry

export function createTokenManager(config, logger) {
  const tokenPath = join(homedir(), '.claude-code-proxy', 'tokens.json');
  let apiKeyOverride = null;
  let cachedToken = null;
  let refreshPromise = null;

  // --- OAuth token file ops ---

  function loadTokens() {
    try {
      if (!existsSync(tokenPath)) return null;
      return JSON.parse(readFileSync(tokenPath, 'utf8'));
    } catch (err) {
      logger.error('Failed to load tokens:', err.message);
      return null;
    }
  }

  function saveTokens(tokens) {
    const dir = dirname(tokenPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), 'utf8');
    if (platform() !== 'win32') chmodSync(tokenPath, 0o600);
    logger.info('Tokens saved');
  }

  function deleteTokens() {
    try {
      if (existsSync(tokenPath)) unlinkSync(tokenPath);
      cachedToken = null;
      logger.info('Tokens deleted');
    } catch (err) {
      logger.error('Failed to delete tokens:', err.message);
      throw err;
    }
  }

  // --- Claude Code credential fallback ---

  function loadClaudeCodeCredentials() {
    try {
      let raw;
      if (platform() === 'win32') {
        const nativePath = join(homedir(), '.claude', '.credentials.json');
        if (existsSync(nativePath)) {
          raw = readFileSync(nativePath, 'utf8');
        } else {
          raw = execSync('wsl cat ~/.claude/.credentials.json', { encoding: 'utf8', timeout: 10_000 });
        }
      } else {
        raw = readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8');
      }
      const creds = JSON.parse(raw);
      return creds.claudeAiOauth || null;
    } catch (err) {
      logger.debug('Could not load Claude Code credentials:', err.message);
      return null;
    }
  }

  function saveClaudeCodeCredentials(oauth) {
    try {
      let raw;
      const nativePath = join(homedir(), '.claude', '.credentials.json');
      if (platform() === 'win32' && !existsSync(nativePath)) {
        raw = execSync('wsl cat ~/.claude/.credentials.json', { encoding: 'utf8', timeout: 10_000 });
      } else {
        raw = readFileSync(nativePath, 'utf8');
      }
      const creds = JSON.parse(raw);
      creds.claudeAiOauth = oauth;
      const json = JSON.stringify(creds);
      if (platform() === 'win32' && !existsSync(nativePath)) {
        execSync('wsl tee ~/.claude/.credentials.json', { input: json, encoding: 'utf8', timeout: 10_000 });
      } else {
        writeFileSync(nativePath, json, 'utf8');
      }
    } catch (err) {
      logger.error('Failed to save Claude Code credentials:', err.message);
    }
  }

  // --- Token endpoint ---

  function callTokenEndpoint(refreshToken) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      });

      const url = new URL(TOKEN_URL);
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
            reject(new Error(`Token request failed (${res.statusCode}): ${data}`));
          }
        });
      });

      req.setTimeout(10_000, () => { req.destroy(); reject(new Error('Token request timeout')); });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  // --- Refresh logic (race-condition safe) ---

  async function refreshOAuthToken() {
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
      try {
        const tokens = loadTokens();
        if (!tokens?.refresh_token) throw new Error('No refresh token available');

        const response = await callTokenEndpoint(tokens.refresh_token);
        const newTokens = {
          access_token: response.access_token,
          refresh_token: response.refresh_token || tokens.refresh_token,
          expires_at: Date.now() + (response.expires_in * 1000),
        };
        saveTokens(newTokens);
        cachedToken = `Bearer ${newTokens.access_token}`;
        logger.info('OAuth token refreshed');
        return cachedToken;
      } finally {
        refreshPromise = null;
      }
    })();

    return refreshPromise;
  }

  async function refreshClaudeCodeToken() {
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
      try {
        const creds = loadClaudeCodeCredentials();
        if (!creds?.refreshToken) throw new Error('No Claude Code refresh token');

        const response = await callTokenEndpoint(creds.refreshToken);
        creds.accessToken = response.access_token;
        creds.refreshToken = response.refresh_token || creds.refreshToken;
        creds.expiresAt = Date.now() + (response.expires_in * 1000);
        saveClaudeCodeCredentials(creds);
        cachedToken = `Bearer ${response.access_token}`;
        logger.info('Claude Code token refreshed');
        return cachedToken;
      } finally {
        refreshPromise = null;
      }
    })();

    return refreshPromise;
  }

  // --- Public API ---

  return {
    loadTokens,
    saveTokens,
    deleteTokens,

    setApiKeyOverride(key) {
      if (key) {
        apiKeyOverride = key.startsWith('Bearer ') ? key : `Bearer ${key}`;
        cachedToken = apiKeyOverride;
      }
    },

    async getValidToken() {
      // 1. API key override
      if (apiKeyOverride) return apiKeyOverride;

      // 2. OAuth tokens
      const tokens = loadTokens();
      if (tokens?.access_token) {
        if (tokens.expires_at > Date.now() + REFRESH_BUFFER_MS) {
          cachedToken = `Bearer ${tokens.access_token}`;
          return cachedToken;
        }
        logger.info('OAuth token expiring soon, refreshing...');
        return refreshOAuthToken();
      }

      // 3. Claude Code credential fallback
      if (config.fallback_to_claude_code) {
        const creds = loadClaudeCodeCredentials();
        if (creds?.accessToken) {
          if (creds.expiresAt && creds.expiresAt > Date.now() + 10_000) {
            cachedToken = `Bearer ${creds.accessToken}`;
            return cachedToken;
          }
          logger.info('Claude Code token expiring, refreshing...');
          return refreshClaudeCodeToken();
        }
      }

      throw new Error('No authentication tokens found. Visit /auth/login to authenticate.');
    },

    clearCachedToken() {
      cachedToken = null;
    },

    isAuthenticated() {
      const tokens = loadTokens();
      return !!(tokens?.access_token && tokens?.refresh_token);
    },

    getTokenExpiration() {
      const tokens = loadTokens();
      return tokens?.expires_at ? new Date(tokens.expires_at) : null;
    },

    logout() {
      deleteTokens();
    },

    // Exposed for OAuth module to call the token endpoint for code exchange
    callTokenEndpoint: callTokenEndpoint,
  };
}
