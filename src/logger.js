import { Transform } from 'node:stream';
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3, TRACE: 4 };

function formatDate() {
  return new Date().toISOString().slice(0, 10);
}

function formatTimestamp() {
  return new Date().toISOString();
}

function argsToString(args) {
  return args.map((a) => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a, null, 2); }
    catch { return String(a); }
  }).join(' ');
}

function createConsoleTransport(level) {
  return {
    level,
    write(prefix, method, args) {
      console[method](`${prefix}:`, ...args);
    },
  };
}

function createFileTransport(level, logsDir) {
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });

  return {
    level,
    write(prefix, _method, args) {
      const filePath = join(logsDir, `proxy-${formatDate()}.log`);
      const line = `${formatTimestamp()} [${prefix}] ${argsToString(args)}\n`;
      appendFileSync(filePath, line, 'utf8');
    },
  };
}

export function createLogger(config) {
  const consoleLevel = LEVELS[config.log_level] ?? LEVELS.INFO;

  const transports = [createConsoleTransport(consoleLevel)];

  if (config.log_file) {
    const fileLevel = LEVELS[config.log_file_level] ?? LEVELS.DEBUG;
    const logsDir = join(process.cwd(), 'logs');
    transports.push(createFileTransport(fileLevel, logsDir));
  }

  // Effective level is the max across all transports (most permissive)
  const effectiveLevel = Math.max(...transports.map((t) => t.level));

  function log(threshold, prefix, method, args) {
    for (const t of transports) {
      if (t.level >= threshold) t.write(prefix, method, args);
    }
  }

  return {
    get level() { return effectiveLevel; },

    error(...args) { log(LEVELS.ERROR, 'ERROR', 'error', args); },
    warn(...args) { log(LEVELS.WARN, 'WARN', 'warn', args); },
    info(...args) { log(LEVELS.INFO, 'INFO', 'log', args); },
    debug(...args) { log(LEVELS.DEBUG, 'DEBUG', 'log', args); },
    trace(...args) { log(LEVELS.TRACE, 'TRACE', 'log', args); },

    createDebugStream(label = 'Stream chunk', textExtractor = null) {
      if (effectiveLevel < LEVELS.DEBUG) {
        return new Transform({
          transform(chunk, _encoding, callback) {
            callback(null, chunk);
          },
        });
      }

      let hasStartedStreaming = false;
      let hasStartedResponse = false;
      let thinkingText = '';

      const self = this;

      return new Transform({
        transform(chunk, _encoding, callback) {
          try {
            const str = chunk.toString();

            if (effectiveLevel >= LEVELS.TRACE) {
              self.trace(`${label} (${str.length} bytes): ${str}`);
            } else if (textExtractor) {
              const result = textExtractor(chunk);
              if (result?.text) {
                if (!hasStartedStreaming) {
                  self.debug(`${label} streaming started`);
                  hasStartedStreaming = true;
                }
                if (thinkingText && !hasStartedResponse) {
                  process.stdout.write('\n');
                  self.debug(`${label} switching from thinking to response`);
                  hasStartedResponse = true;
                }
                process.stdout.write(result.text);
                // File transport gets the text via debug
                for (const t of transports) {
                  if (t.level >= LEVELS.DEBUG && t !== transports[0]) {
                    t.write('DEBUG', 'log', [`${label} text: ${result.text}`]);
                  }
                }
              }
              if (result?.thinking) {
                if (!hasStartedStreaming) {
                  self.debug(`${label} streaming started`);
                  hasStartedStreaming = true;
                }
                thinkingText += result.thinking;
                process.stdout.write(`\x1b[90m${result.thinking}\x1b[0m`);
                for (const t of transports) {
                  if (t.level >= LEVELS.DEBUG && t !== transports[0]) {
                    t.write('DEBUG', 'log', [`${label} thinking: ${result.thinking}`]);
                  }
                }
              }
            } else {
              self.debug(`${label} (${str.length} bytes): ${str}`);
            }
          } catch {
            self.debug(`${label} (failed to decode)`);
          }
          callback(null, chunk);
        },
      });
    },
  };
}
