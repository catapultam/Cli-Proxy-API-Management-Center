import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { apiClient } from '@/services/api/client';
import { sessionApi } from '@/services/api/session';
import { handleSessionRefreshToken, useAuthStore } from '@/stores/useAuthStore';
import { useConfigStore } from '@/stores/useConfigStore';
import type { SessionStatus } from '@/types';

const spies: Array<{ mockRestore(): void }> = [];
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalLogin = useAuthStore.getState().login;
const originalFetchConfig = useConfigStore.getState().fetchConfig;
const memory = new Map<string, string>();

function setFakeWindow(origin: string) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin, host: new URL(origin).host } },
  });
}

// `afterEach` below always calls the real `logout()` action to reset the store's internal
// `restoreSessionPromise` cache between tests; stub the network call it makes so tests never
// hit the (nonexistent) `*.example` test domains.
let logoutNetworkSpy: ReturnType<typeof spyOn>;

beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, value),
      removeItem: (key: string) => memory.delete(key),
    },
  });
  setFakeWindow('https://panel.example');
  logoutNetworkSpy = spyOn(sessionApi, 'logout').mockResolvedValue(undefined as never);
});

afterAll(() => {
  logoutNetworkSpy.mockRestore();
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

afterEach(async () => {
  spies.splice(0).forEach((spy) => spy.mockRestore());
  // Zustand replaces its state object on every `set()`; mockRestore alone can leave a mocked
  // action referenced by newer states, so put the real implementations back explicitly.
  useAuthStore.setState({ login: originalLogin });
  useConfigStore.setState({ fetchConfig: originalFetchConfig });
  memory.clear();
  await useAuthStore.getState().logout();
  useAuthStore.setState({
    isAuthenticated: false,
    connectionStatus: 'disconnected',
    sessionStatus: null,
  });
  apiClient.setConfig({ apiBase: '', managementKey: '' });
  setFakeWindow('https://panel.example');
});

const SESSION_RESPONSE = { token: 'cpas_new-token', expires_at: '2026-11-01T00:00:00Z' };

describe('applySessionLogin transport selection', () => {
  test('uses cookie transport when the API base is same-origin as the page', () => {
    setFakeWindow('https://panel.example');
    useAuthStore
      .getState()
      .applySessionLogin('https://panel.example', SESSION_RESPONSE, 'password');

    const state = useAuthStore.getState();
    expect(state.sessionTransport).toBe('cookie');
    expect(state.managementKey).toBe('');
    expect(state.authMode).toBe('session');
    expect(state.isAuthenticated).toBe(true);
    expect(state.loginMethod).toBe('password');
    expect(state.sessionExpiresAt).toBe(SESSION_RESPONSE.expires_at);
  });

  test('uses bearer transport and stores the token when cross-origin', () => {
    setFakeWindow('https://panel.example');
    useAuthStore
      .getState()
      .applySessionLogin('https://api.other-origin.example', SESSION_RESPONSE, 'passkey');

    const state = useAuthStore.getState();
    expect(state.sessionTransport).toBe('bearer');
    expect(state.managementKey).toBe(SESSION_RESPONSE.token);
    expect(state.loginMethod).toBe('passkey');
  });
});

describe('X-CPA-Session-Refresh handling', () => {
  test('replaces the stored bearer token on a session-refresh event', () => {
    setFakeWindow('https://panel.example');
    useAuthStore
      .getState()
      .applySessionLogin('https://api.other-origin.example', SESSION_RESPONSE, 'password');
    expect(useAuthStore.getState().sessionTransport).toBe('bearer');

    handleSessionRefreshToken('cpas_refreshed-token');

    expect(useAuthStore.getState().managementKey).toBe('cpas_refreshed-token');
  });

  test('is ignored in cookie-session mode', () => {
    setFakeWindow('https://panel.example');
    useAuthStore
      .getState()
      .applySessionLogin('https://panel.example', SESSION_RESPONSE, 'password');
    expect(useAuthStore.getState().sessionTransport).toBe('cookie');

    handleSessionRefreshToken('cpas_should-be-ignored');

    expect(useAuthStore.getState().managementKey).toBe('');
  });

  test('is ignored in key mode', () => {
    useAuthStore.setState({
      authMode: 'key',
      sessionTransport: 'bearer',
      managementKey: 'real-key',
    });

    handleSessionRefreshToken('cpas_should-be-ignored');

    expect(useAuthStore.getState().managementKey).toBe('real-key');
  });

  test('ignores a missing/empty token', () => {
    useAuthStore
      .getState()
      .applySessionLogin('https://api.other-origin.example', SESSION_RESPONSE, 'password');

    handleSessionRefreshToken(undefined);
    handleSessionRefreshToken('');

    expect(useAuthStore.getState().managementKey).toBe(SESSION_RESPONSE.token);
  });
});

describe('restoreSession', () => {
  test('logs straight in with no prompt when session/status reports authenticated', async () => {
    setFakeWindow('https://panel.example');
    useAuthStore.setState({ apiBase: 'https://panel.example' });
    const status: SessionStatus = {
      account: true,
      authenticated: true,
      method: 'password',
      passkeys_available: false,
      passkey_origins: [],
    };
    spies.push(spyOn(sessionApi, 'getStatus').mockResolvedValue(status));
    const loginSpy = spyOn(useAuthStore.getState(), 'login');
    spies.push(loginSpy);

    const result = await useAuthStore.getState().restoreSession();

    expect(result).toBe(true);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().authMode).toBe('session');
    expect(useAuthStore.getState().sessionTransport).toBe('cookie');
    expect(loginSpy).not.toHaveBeenCalled();
  });

  test('old-backend 404 on session/status falls back to the unchanged remembered-key flow', async () => {
    localStorage.setItem('isLoggedIn', 'true');
    useAuthStore.setState({
      apiBase: 'https://panel.example',
      managementKey: 'remembered-key',
      rememberPassword: true,
      authMode: 'key',
    });
    const notFound = Object.assign(new Error('not found'), { status: 404 });
    spies.push(spyOn(sessionApi, 'getStatus').mockRejectedValue(notFound));
    const fetchConfigSpy = spyOn(useConfigStore.getState(), 'fetchConfig').mockResolvedValue(
      undefined as never
    );
    spies.push(fetchConfigSpy);

    const result = await useAuthStore.getState().restoreSession();

    expect(result).toBe(true);
    expect(fetchConfigSpy).toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().authMode).toBe('key');
    expect(useAuthStore.getState().managementKey).toBe('remembered-key');
  });

  test('does not retry a stale session token against the legacy key flow', async () => {
    useAuthStore.setState({
      apiBase: 'https://api.other-origin.example',
      managementKey: 'cpas_expired-token',
      authMode: 'session',
      sessionTransport: 'bearer',
    });
    const unauthenticated: SessionStatus = {
      account: true,
      authenticated: false,
      method: '',
      passkeys_available: false,
      passkey_origins: [],
    };
    spies.push(spyOn(sessionApi, 'getStatus').mockResolvedValue(unauthenticated));
    const loginSpy = spyOn(useAuthStore.getState(), 'login');
    spies.push(loginSpy);

    const result = await useAuthStore.getState().restoreSession();

    expect(result).toBe(false);
    expect(loginSpy).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().authMode).toBe('key');
    expect(useAuthStore.getState().managementKey).toBe('');
  });

  test('a network error probing session/status falls back to the remembered-key flow', async () => {
    localStorage.setItem('isLoggedIn', 'true');
    useAuthStore.setState({
      apiBase: 'https://panel.example',
      managementKey: 'remembered-key',
      rememberPassword: true,
      authMode: 'key',
    });
    spies.push(spyOn(sessionApi, 'getStatus').mockRejectedValue(new Error('network unavailable')));
    const fetchConfigSpy = spyOn(useConfigStore.getState(), 'fetchConfig').mockResolvedValue(
      undefined as never
    );
    spies.push(fetchConfigSpy);

    const result = await useAuthStore.getState().restoreSession();

    expect(result).toBe(true);
    expect(useAuthStore.getState().authMode).toBe('key');
  });
});
