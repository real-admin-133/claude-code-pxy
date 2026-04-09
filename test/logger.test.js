import { jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '../src/logger.js';

describe('createLogger', () => {
  let originalLog, originalError, originalWarn;

  beforeEach(() => {
    originalLog = console.log;
    originalError = console.error;
    originalWarn = console.warn;
    console.log = jest.fn();
    console.error = jest.fn();
    console.warn = jest.fn();
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  });

  test('error logs at all levels', () => {
    const logger = createLogger({ log_level: 'ERROR' });
    logger.error('test');
    expect(console.error).toHaveBeenCalledWith('ERROR:', 'test');
  });

  test('warn does not log at ERROR level', () => {
    const logger = createLogger({ log_level: 'ERROR' });
    logger.warn('test');
    expect(console.warn).not.toHaveBeenCalled();
  });

  test('warn logs at WARN level', () => {
    const logger = createLogger({ log_level: 'WARN' });
    logger.warn('test');
    expect(console.warn).toHaveBeenCalledWith('WARN:', 'test');
  });

  test('info does not log at WARN level', () => {
    const logger = createLogger({ log_level: 'WARN' });
    logger.info('test');
    expect(console.log).not.toHaveBeenCalled();
  });

  test('info logs at INFO level', () => {
    const logger = createLogger({ log_level: 'INFO' });
    logger.info('test');
    expect(console.log).toHaveBeenCalledWith('INFO:', 'test');
  });

  test('debug does not log at INFO level', () => {
    const logger = createLogger({ log_level: 'INFO' });
    logger.debug('test');
    expect(console.log).not.toHaveBeenCalled();
  });

  test('debug logs at DEBUG level', () => {
    const logger = createLogger({ log_level: 'DEBUG' });
    logger.debug('test');
    expect(console.log).toHaveBeenCalledWith('DEBUG:', 'test');
  });

  test('trace does not log at DEBUG level', () => {
    const logger = createLogger({ log_level: 'DEBUG' });
    logger.trace('test');
    expect(console.log).not.toHaveBeenCalled();
  });

  test('trace logs at TRACE level', () => {
    const logger = createLogger({ log_level: 'TRACE' });
    logger.trace('test');
    expect(console.log).toHaveBeenCalledWith('TRACE:', 'test');
  });

  test('defaults to INFO when log_level is unknown', () => {
    const logger = createLogger({ log_level: 'UNKNOWN' });
    logger.info('test');
    expect(console.log).toHaveBeenCalledWith('INFO:', 'test');
    logger.debug('test2');
    expect(console.log).toHaveBeenCalledTimes(1);
  });

  test('exposes level as a number', () => {
    const logger = createLogger({ log_level: 'DEBUG' });
    expect(logger.level).toBe(3);
  });
});

describe('file transport', () => {
  let originalCwd, tmpDir;
  let originalLog, originalError, originalWarn;

  beforeEach(() => {
    originalLog = console.log;
    originalError = console.error;
    originalWarn = console.warn;
    console.log = jest.fn();
    console.error = jest.fn();
    console.warn = jest.fn();

    tmpDir = mkdtempSync(join(tmpdir(), 'logger-test-'));
    originalCwd = process.cwd;
    process.cwd = () => tmpDir;
  });

  afterEach(() => {
    process.cwd = originalCwd;
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writes to file when log_file is true', () => {
    const logger = createLogger({ log_level: 'INFO', log_file: true, log_file_level: 'DEBUG' });
    logger.info('hello file');

    const logsDir = join(tmpDir, 'logs');
    const files = readdirSync(logsDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^proxy-\d{4}-\d{2}-\d{2}\.log$/);

    const content = readFileSync(join(logsDir, files[0]), 'utf8');
    expect(content).toContain('[INFO]');
    expect(content).toContain('hello file');
  });

  test('file transport respects its own level', () => {
    const logger = createLogger({ log_level: 'ERROR', log_file: true, log_file_level: 'INFO' });
    logger.info('should be in file');
    logger.debug('should not be in file');

    const logsDir = join(tmpDir, 'logs');
    const files = readdirSync(logsDir);
    const content = readFileSync(join(logsDir, files[0]), 'utf8');
    expect(content).toContain('should be in file');
    expect(content).not.toContain('should not be in file');
  });

  test('does not write file when log_file is false', () => {
    const logger = createLogger({ log_level: 'DEBUG', log_file: false });
    logger.debug('no file');

    const logsDir = join(tmpDir, 'logs');
    expect(() => readdirSync(logsDir)).toThrow();
  });

  test('effective level is max of console and file levels', () => {
    const logger = createLogger({ log_level: 'ERROR', log_file: true, log_file_level: 'DEBUG' });
    // Console is ERROR (0), file is DEBUG (3), effective should be 3
    expect(logger.level).toBe(3);
  });

  test('pretty-prints objects in file', () => {
    const logger = createLogger({ log_level: 'INFO', log_file: true, log_file_level: 'DEBUG' });
    logger.info('data:', { key: 'value' });

    const logsDir = join(tmpDir, 'logs');
    const files = readdirSync(logsDir);
    const content = readFileSync(join(logsDir, files[0]), 'utf8');
    expect(content).toContain('"key": "value"');
  });
});

describe('createDebugStream', () => {
  test('passthrough at INFO level', (done) => {
    const logger = createLogger({ log_level: 'INFO' });
    const stream = logger.createDebugStream('test');
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      expect(Buffer.concat(chunks).toString()).toBe('hello');
      done();
    });
    stream.write('hello');
    stream.end();
  });

  test('passthrough at DEBUG level preserves data', (done) => {
    const origLog = console.log;
    console.log = jest.fn();

    const logger = createLogger({ log_level: 'DEBUG' });
    const stream = logger.createDebugStream('test', (chunk) => {
      return { text: chunk.toString() };
    });
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      expect(Buffer.concat(chunks).toString()).toBe('hello');
      console.log = origLog;
      done();
    });
    stream.write('hello');
    stream.end();
  });
});
