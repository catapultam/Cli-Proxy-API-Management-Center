import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import axios from 'axios';
import { isCookieEligible } from '@/utils/connection';
import { sessionApi } from '@/services/api/session';
import { REQUEST_TIMEOUT_MS } from '@/utils/constants';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

beforeAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'https://panel.example' } },
  });
});

afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('isCookieEligible (cookie Path is /v8/management)', () => {
  test('same origin, no path prefix: cookie mode', () => {
    expect(isCookieEligible('https://panel.example')).toBe(true);
    expect(isCookieEligible('https://panel.example/')).toBe(true);
  });

  test('same origin with a deployment path prefix: bearer', () => {
    expect(isCookieEligible('https://panel.example/gateway')).toBe(false);
  });

  test('different origin: bearer', () => {
    expect(isCookieEligible('https://other.example')).toBe(false);
    expect(isCookieEligible('http://panel.example')).toBe(false);
  });

  test('empty or invalid input is not eligible', () => {
    expect(isCookieEligible('')).toBe(false);
  });
});

describe('session requests', () => {
  test('carry a timeout', async () => {
    const spy = spyOn(axios, 'request').mockResolvedValue({ data: {} } as never);
    await sessionApi.getStatus('https://panel.example');
    const config = spy.mock.calls[0]?.[0] as { timeout?: number };
    expect(config.timeout).toBe(REQUEST_TIMEOUT_MS);
    spy.mockRestore();
  });
});
