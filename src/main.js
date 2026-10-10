import { exec } from 'node:child_process';
import { platform } from 'node:os';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createTokenManager } from './token-manager.js';
import { createOAuthManager } from './oauth.js';
import { createProxy } from './proxy.js';
import { createHttpServer } from './http-server.js';

let httpServer = null;
let oauthManager = null;

function openBrowser(url) {
  let command;
  const plat = platform();
  if (plat === 'darwin') command = `open "${url}"`;
  else if (plat === 'win32') command = `cmd /c start "" "${url}"`;
  else command = `xdg-open "${url}"`;

  exec(command, (err) => {
    if (err) console.log(`DEBUG: Failed to open browser: ${err.message}`);
  });
}

const SOURCE_LABELS = {
  api_key: 'API key override',
  oauth: 'OAuth tokens',
  claude_code: 'Claude Code credentials',
};

function describeAuthStatus(status) {
  const source = SOURCE_LABELS[status.source] || 'unknown source';
  const expiry = status.expires_at ? status.expires_at.toLocaleString() : 'no expiry recorded';

  switch (status.state) {
    case 'valid':
      return `Ready (${source}) - valid until ${expiry}`;
    case 'refreshable':
      return `Ready (${source}) - access token stale, will refresh on first request`;
    case 'expired':
      return `Expired (${source}) - no refresh token, re-authentication required`;
    default:
      return 'Not authenticated - no credentials found';
  }
}

export async function start(configDir) {
  const config = loadConfig(configDir);
  const logger = createLogger(config);
  const tokenManager = createTokenManager(config, logger);
  oauthManager = createOAuthManager(config, logger, tokenManager);
  const proxy = createProxy(config, logger, tokenManager);
  httpServer = createHttpServer(config, logger, oauthManager, proxy);

  oauthManager.startCleanupInterval();
  await httpServer.listen();

  // Display auth status
  const status = tokenManager.getAuthStatus();
  const authUrl = `${config.publicBaseUrl}/auth/login`;

  logger.info('');
  logger.info('Authentication Status:');
  logger.info(`  ${describeAuthStatus(status)}`);
  logger.info(`  Log in / re-authenticate: ${authUrl}`);
  logger.info(`  Check status:             ${config.publicBaseUrl}/auth/status`);

  if (!status.usable && config.auto_open_browser && config.resolvedHost !== '0.0.0.0') {
    logger.info('  Opening browser...');
    setTimeout(() => openBrowser(authUrl), 1000);
  }
  logger.info('');

  return { config, logger, tokenManager, oauthManager, proxy, httpServer };
}

export async function stop() {
  if (oauthManager) oauthManager.stopCleanupInterval();
  if (httpServer) await httpServer.close();
}

// Signal handlers + auto-start when run directly
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  start().catch((err) => {
    console.error('Failed to start:', err.message);
    process.exit(1);
  });

  process.on('SIGTERM', async () => {
    console.log('INFO: Shutting down...');
    await stop();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('INFO: Shutting down...');
    await stop();
    process.exit(0);
  });
}
