import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULTS = {
  port: 42069,
  host: '',
  log_level: 'INFO',
  filter_sampling_params: false,
  auto_open_browser: true,
  fallback_to_claude_code: true,
  strip_ttl: true,
  max_body_bytes: 10_000_000,
  beta_header: 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14',
  log_file: false,
  log_file_level: 'DEBUG',
};

const ENV_MAP = {
  PORT: 'port',
  HOST: 'host',
  LOG_LEVEL: 'log_level',
  FILTER_SAMPLING_PARAMS: 'filter_sampling_params',
  AUTO_OPEN_BROWSER: 'auto_open_browser',
  FALLBACK_TO_CLAUDE_CODE: 'fallback_to_claude_code',
  STRIP_TTL: 'strip_ttl',
  MAX_BODY_BYTES: 'max_body_bytes',
  BETA_HEADER: 'beta_header',
  LOG_FILE: 'log_file',
  LOG_FILE_LEVEL: 'log_file_level',
};

const BOOLEAN_KEYS = new Set([
  'filter_sampling_params', 'auto_open_browser',
  'fallback_to_claude_code', 'strip_ttl', 'log_file',
]);

const INTEGER_KEYS = new Set(['port', 'max_body_bytes']);

function coerce(key, value) {
  if (BOOLEAN_KEYS.has(key)) {
    if (typeof value === 'string') return value.toLowerCase() === 'true';
    return Boolean(value);
  }
  if (INTEGER_KEYS.has(key)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : DEFAULTS[key];
  }
  return value;
}

function readJSON(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function isRunningInDocker() {
  if (existsSync('/.dockerenv')) return true;
  try {
    const cgroup = readFileSync('/proc/self/cgroup', 'utf8');
    return cgroup.includes('docker') || cgroup.includes('containerd');
  } catch {
    return false;
  }
}

export function loadConfig(configDir) {
  configDir = configDir || process.env.CONFIG_DIR || join(process.cwd(), 'config');

  const basePath = join(configDir, 'config.json');
  const localPath = join(configDir, 'config.local.json');

  const base = readJSON(basePath);
  if (!base) {
    throw new Error(`Cannot read base config: ${basePath}`);
  }

  let local = readJSON(localPath);

  if (!local) {
    // First startup: create config.local.json as a copy of base
    writeFileSync(localPath, JSON.stringify(base, null, 2), 'utf8');
    local = { ...base };
  } else if (base.version > (local.version || 0)) {
    // Version upgrade: merge base into local (local values take precedence)
    const merged = { ...base };
    for (const [key, value] of Object.entries(local)) {
      if (key !== 'version' && key in base) {
        merged[key] = value;
      }
    }
    merged.version = base.version;
    writeFileSync(localPath, JSON.stringify(merged, null, 2), 'utf8');
    local = merged;
    // Log to stdout directly since logger isn't initialized yet
    console.log(`Config updated to version ${base.version}`);
  }

  // Build config: defaults <- base <- local (local wins)
  const config = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (key in local && local[key] !== undefined) {
      config[key] = local[key];
    } else if (key in base && base[key] !== undefined) {
      config[key] = base[key];
    }
  }

  // Apply env var overrides
  for (const [envKey, configKey] of Object.entries(ENV_MAP)) {
    if (process.env[envKey] !== undefined) {
      config[configKey] = coerce(configKey, process.env[envKey]);
    }
  }

  // Coerce types from JSON (in case local file has wrong types)
  for (const key of Object.keys(config)) {
    config[key] = coerce(key, config[key]);
  }

  // Resolve host: empty = auto-detect
  config.resolvedHost = config.host || (isRunningInDocker() ? '0.0.0.0' : '127.0.0.1');

  return Object.freeze(config);
}
