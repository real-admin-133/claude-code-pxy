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
  const isAuthenticated = tokenManager.isAuthenticated();
  const expiration = tokenManager.getTokenExpiration();

  logger.info('');
  logger.info('Authentication Status:');
  if (isAuthenticated && expiration) {
    logger.info(`  Authenticated until ${expiration.toLocaleString()}`);
  } else {
    logger.info('  Not authenticated');
    const authUrl = `http://localhost:${config.port}/auth/login`;
    logger.info(`  Visit ${authUrl} to authenticate`);

    if (config.auto_open_browser && config.resolvedHost !== '0.0.0.0') {
      logger.info('  Opening browser...');
      setTimeout(() => openBrowser(authUrl), 1000);
    }
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
