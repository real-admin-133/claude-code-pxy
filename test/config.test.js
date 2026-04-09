import { jest } from '@jest/globals';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let loadConfig;

beforeEach(async () => {
  // Clear env vars before each test
  for (const key of ['PORT', 'HOST', 'LOG_LEVEL', 'FILTER_SAMPLING_PARAMS',
    'AUTO_OPEN_BROWSER', 'FALLBACK_TO_CLAUDE_CODE', 'STRIP_TTL',
    'MAX_BODY_BYTES', 'BETA_HEADER', 'CONFIG_DIR']) {
    delete process.env[key];
  }
  // Re-import to get a clean module
  const mod = await import('../src/config.js');
  loadConfig = mod.loadConfig;
});

function makeConfigDir(base = {}, local = null) {
  const dir = mkdtempSync(join(tmpdir(), 'config-test-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 1, ...base }));
  if (local) {
    writeFileSync(join(dir, 'config.local.json'), JSON.stringify(local));
  }
  return dir;
}

describe('loadConfig', () => {
  let dirs = [];

  afterEach(() => {
    dirs.forEach(d => rmSync(d, { recursive: true, force: true }));
    dirs = [];
  });

  function tracked(base, local) {
    const d = makeConfigDir(base, local);
    dirs.push(d);
    return d;
  }

  test('loads defaults when config.json has only version', () => {
    const dir = tracked({});
    const config = loadConfig(dir);
    expect(config.port).toBe(42069);
    expect(config.log_level).toBe('INFO');
    expect(config.filter_sampling_params).toBe(false);
    expect(config.auto_open_browser).toBe(true);
    expect(config.strip_ttl).toBe(true);
    expect(config.max_body_bytes).toBe(10_000_000);
  });

  test('returns frozen object', () => {
    const dir = tracked({});
    const config = loadConfig(dir);
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => { config.port = 9999; }).toThrow();
  });

  test('creates config.local.json on first startup', () => {
    const dir = tracked({ port: 42069 });
    loadConfig(dir);
    const local = JSON.parse(readFileSync(join(dir, 'config.local.json'), 'utf8'));
    expect(local.version).toBe(1);
    expect(local.port).toBe(42069);
  });

  test('local overrides base', () => {
    const dir = tracked(
      { port: 42069, log_level: 'INFO' },
      { version: 1, port: 8080, log_level: 'DEBUG' }
    );
    const config = loadConfig(dir);
    expect(config.port).toBe(8080);
    expect(config.log_level).toBe('DEBUG');
  });

  test('version upgrade merges new keys while preserving local overrides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'));
    dirs.push(dir);

    // Base at version 2 with a new key (strip_ttl changed)
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      version: 2,
      port: 42069,
      log_level: 'INFO',
      strip_ttl: false,
    }));
    // Local at version 1 with user override on port
    writeFileSync(join(dir, 'config.local.json'), JSON.stringify({
      version: 1,
      port: 9000,
      log_level: 'WARN',
    }));

    const config = loadConfig(dir);
    // User's port override preserved
    expect(config.port).toBe(9000);
    // User's log_level override preserved
    expect(config.log_level).toBe('WARN');
    // New strip_ttl from base picked up (since local didn't have it before merge)
    // After merge: base strip_ttl=false is used since local didn't override it
    expect(config.strip_ttl).toBe(false);

    // Local file updated to version 2
    const updated = JSON.parse(readFileSync(join(dir, 'config.local.json'), 'utf8'));
    expect(updated.version).toBe(2);
  });

  test('env vars override config', () => {
    const dir = tracked({ port: 42069 });
    process.env.PORT = '3000';
    process.env.LOG_LEVEL = 'DEBUG';
    process.env.FILTER_SAMPLING_PARAMS = 'true';
    const config = loadConfig(dir);
    expect(config.port).toBe(3000);
    expect(config.log_level).toBe('DEBUG');
    expect(config.filter_sampling_params).toBe(true);
  });

  test('coerces boolean env vars', () => {
    const dir = tracked({});
    process.env.AUTO_OPEN_BROWSER = 'false';
    process.env.STRIP_TTL = 'true';
    const config = loadConfig(dir);
    expect(config.auto_open_browser).toBe(false);
    expect(config.strip_ttl).toBe(true);
  });

  test('coerces integer env vars', () => {
    const dir = tracked({});
    process.env.PORT = '8080';
    process.env.MAX_BODY_BYTES = '5000000';
    const config = loadConfig(dir);
    expect(config.port).toBe(8080);
    expect(config.max_body_bytes).toBe(5_000_000);
  });

  test('resolvedHost defaults to 127.0.0.1 for non-Docker', () => {
    const dir = tracked({});
    const config = loadConfig(dir);
    expect(config.resolvedHost).toBe('127.0.0.1');
  });

  test('resolvedHost uses explicit host if set', () => {
    const dir = tracked({ host: '192.168.1.1' });
    const config = loadConfig(dir);
    expect(config.resolvedHost).toBe('192.168.1.1');
  });

  test('throws if base config.json is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-test-'));
    dirs.push(dir);
    expect(() => loadConfig(dir)).toThrow('Cannot read base config');
  });
});
