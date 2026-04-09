import { jest } from '@jest/globals';
import { createProxy } from '../src/proxy.js';

function makeLogger() {
  return {
    level: 2,
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn(),
    createDebugStream: jest.fn(),
  };
}

function makeTokenManager() {
  return {
    getValidToken: jest.fn(async () => 'Bearer test-token'),
    clearCachedToken: jest.fn(),
  };
}

describe('createProxy', () => {
  describe('processRequestBody', () => {
    test('prepends system prompt when no system exists', () => {
      const proxy = createProxy({ strip_ttl: false, filter_sampling_params: false }, makeLogger(), makeTokenManager());
      const body = { messages: [{ role: 'user', content: 'hello' }] };
      const result = proxy.processRequestBody(body);
      expect(result.system).toHaveLength(1);
      expect(result.system[0].text).toContain('Claude Code');
    });

    test('prepends system prompt to existing array', () => {
      const proxy = createProxy({ strip_ttl: false, filter_sampling_params: false }, makeLogger(), makeTokenManager());
      const body = {
        system: [{ type: 'text', text: 'Be helpful' }],
        messages: [],
      };
      const result = proxy.processRequestBody(body);
      expect(result.system).toHaveLength(2);
      expect(result.system[0].text).toContain('Claude Code');
      expect(result.system[1].text).toBe('Be helpful');
    });

    test('converts string system to array with prepended prompt', () => {
      const proxy = createProxy({ strip_ttl: false, filter_sampling_params: false }, makeLogger(), makeTokenManager());
      const body = { system: 'Be helpful', messages: [] };
      const result = proxy.processRequestBody(body);
      expect(result.system).toHaveLength(2);
      expect(result.system[0].text).toContain('Claude Code');
      expect(result.system[1].text).toBe('Be helpful');
    });

    test('returns null/undefined body as-is', () => {
      const proxy = createProxy({ strip_ttl: false, filter_sampling_params: false }, makeLogger(), makeTokenManager());
      expect(proxy.processRequestBody(null)).toBeNull();
      expect(proxy.processRequestBody(undefined)).toBeUndefined();
    });
  });

  describe('stripTtlFromCacheControl', () => {
    test('removes ttl from system cache_control', () => {
      const proxy = createProxy({ strip_ttl: true, filter_sampling_params: false }, makeLogger(), makeTokenManager());
      const body = {
        system: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral', ttl: 300 } }],
      };
      proxy.stripTtlFromCacheControl(body);
      expect(body.system[0].cache_control.ttl).toBeUndefined();
      expect(body.system[0].cache_control.type).toBe('ephemeral');
    });

    test('removes ttl from message content cache_control', () => {
      const proxy = createProxy({ strip_ttl: true, filter_sampling_params: false }, makeLogger(), makeTokenManager());
      const body = {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: 60 } }] }],
      };
      proxy.stripTtlFromCacheControl(body);
      expect(body.messages[0].content[0].cache_control.ttl).toBeUndefined();
    });

    test('does nothing when strip_ttl is false', () => {
      const proxy = createProxy({ strip_ttl: false, filter_sampling_params: false }, makeLogger(), makeTokenManager());
      const body = {
        system: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral', ttl: 300 } }],
      };
      proxy.stripTtlFromCacheControl(body);
      expect(body.system[0].cache_control.ttl).toBe(300);
    });
  });

  describe('filterSamplingParams', () => {
    test('removes top_p when both present and top_p is default', () => {
      const proxy = createProxy({ strip_ttl: false, filter_sampling_params: true }, makeLogger(), makeTokenManager());
      const body = { temperature: 0.7, top_p: 1.0 };
      proxy.filterSamplingParams(body);
      expect(body.temperature).toBe(0.7);
      expect(body.top_p).toBeUndefined();
    });

    test('removes temperature when both present and temperature is default', () => {
      const proxy = createProxy({ strip_ttl: false, filter_sampling_params: true }, makeLogger(), makeTokenManager());
      const body = { temperature: 1.0, top_p: 0.9 };
      proxy.filterSamplingParams(body);
      expect(body.temperature).toBeUndefined();
      expect(body.top_p).toBe(0.9);
    });

    test('removes top_p when both non-default (prefers temperature)', () => {
      const proxy = createProxy({ strip_ttl: false, filter_sampling_params: true }, makeLogger(), makeTokenManager());
      const body = { temperature: 0.5, top_p: 0.8 };
      proxy.filterSamplingParams(body);
      expect(body.temperature).toBe(0.5);
      expect(body.top_p).toBeUndefined();
    });

    test('removes default-value solo param', () => {
      const proxy = createProxy({ strip_ttl: false, filter_sampling_params: true }, makeLogger(), makeTokenManager());
      const body = { top_p: 1.0 };
      proxy.filterSamplingParams(body);
      expect(body.top_p).toBeUndefined();
    });

    test('does nothing when filter_sampling_params is false', () => {
      const proxy = createProxy({ strip_ttl: false, filter_sampling_params: false }, makeLogger(), makeTokenManager());
      const body = { temperature: 0.7, top_p: 0.9 };
      proxy.filterSamplingParams(body);
      expect(body.temperature).toBe(0.7);
      expect(body.top_p).toBe(0.9);
    });
  });
});
