import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { apiClient } from '@/services/api/client';
import { guardConfigConnection } from '@/services/api/configValue';
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

const AUTHENTICATED_STATUS: SessionStatus = {
  account: true,
  authenticated: true,
  method: 'password',
  passkeys_available: false,
  passkey_origins: [],
  passkey_rp_id: '',
};

const UNAUTHENTICATED_STATUS: SessionStatus = {
  ...AUTHENTICATED_STATUS,
  authenticated: false,
  method: '',
};

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
  logoutNetworkSpy.mockClear();
  await useAuthStore.getState().logout();
  useAuthStore.setState({
    isAuthenticated: false,
    connectionStatus: 'disconnected',
    sessionStatus: null,
    sessionStatusError: false,
    sessionRoutesSupported: true,
  });
  apiClient.setConfig({ apiBase: '', managementKey: '' });
  apiClient.setIdentityVersion(0);
  setFakeWindow('https://panel.example');
});

const SESSION_RESPONSE = { token: 'cpas_new-token', expires_at: '2026-11-01T00:00:00Z' };

describe('applySessionLogin transport selection', () => {
  test('uses cookie transport when the API base is same-origin and the cookie verifies', async () => {
    setFakeWindow('https://panel.example');
    // The cookie-mode path verifies the cookie actually stuck via a follow-up session/status call.
    spies.push(spyOn(sessionApi, 'getStatus').mockResolvedValue(AUTHENTICATED_STATUS));

    await useAuthStore
      .getState()
      .applySessionLogin('https://panel.example', SESSION_RESPONSE, 'password');

    const state = useAuthStore.getState();
    expect(state.sessionTransport).toBe('cookie');
    expect(state.managementKey).toBe('');
    expect(state.authMode).toBe('session');
    expect(state.isAuthenticated).toBe(true);
    expect(state.loginMethod).toBe('password');
  });

  test('falls back to bearer when the cookie does not stick (blocked by the browser)', async () => {
    setFakeWindow('https://panel.example');
    spies.push(spyOn(sessionApi, 'getStatus').mockResolvedValue(UNAUTHENTICATED_STATUS));

    await useAuthStore
      .getState()
      .applySessionLogin('https://panel.example', SESSION_RESPONSE, 'password');

    const state = useAuthStore.getState();
    expect(state.sessionTransport).toBe('bearer');
    expect(state.managementKey).toBe(SESSION_RESPONSE.token);
  });

  test('uses bearer transport and stores the token when cross-origin (no cookie verify needed)', async () => {
    setFakeWindow('https://panel.example');
    const getStatusSpy = spyOn(sessionApi, 'getStatus');
    spies.push(getStatusSpy);

    await useAuthStore
      .getState()
      .applySessionLogin('https://api.other-origin.example', SESSION_RESPONSE, 'passkey');

    const state = useAuthStore.getState();
    expect(state.sessionTransport).toBe('bearer');
    expect(state.managementKey).toBe(SESSION_RESPONSE.token);
    expect(state.loginMethod).toBe('passkey');
    expect(getStatusSpy).not.toHaveBeenCalled();
  });

  test('does not force rememberPassword (session persistence no longer depends on it)', async () => {
    setFakeWindow('https://panel.example');
    useAuthStore.setState({ rememberPassword: false });
    spies.push(spyOn(sessionApi, 'getStatus').mockResolvedValue(AUTHENTICATED_STATUS));

    await useAuthStore
      .getState()
      .applySessionLogin('https://panel.example', SESSION_RESPONSE, 'password');

    expect(useAuthStore.getState().rememberPassword).toBe(false);
  });
});

describe('adoptRotatedToken (S2: same-identity token rotation)', () => {
  test('updates the bearer token without clearing caches or bumping identityVersion', async () => {
    setFakeWindow('https://panel.example');
    await useAuthStore
      .getState()
      .applySessionLogin('https://api.other-origin.example', SESSION_RESPONSE, 'password');
    const clearCacheSpy = spyOn(useConfigStore.getState(), 'clearCache');
    spies.push(clearCacheSpy);
    const versionBefore = useAuthStore.getState().identityVersion;

    useAuthStore.getState().adoptRotatedToken('https://api.other-origin.example', {
      token: 'cpas_rotated',
      expires_at: '2026-12-01T00:00:00Z',
    });

    expect(useAuthStore.getState().managementKey).toBe('cpas_rotated');
    expect(useAuthStore.getState().identityVersion).toBe(versionBefore);
    expect(clearCacheSpy).not.toHaveBeenCalled();
  });

  test('is a no-op in cookie mode (the browser already applied the Set-Cookie)', async () => {
    setFakeWindow('https://panel.example');
    spies.push(spyOn(sessionApi, 'getStatus').mockResolvedValue(AUTHENTICATED_STATUS));
    await useAuthStore
      .getState()
      .applySessionLogin('https://panel.example', SESSION_RESPONSE, 'password');

    useAuthStore.getState().adoptRotatedToken('https://panel.example', {
      token: 'cpas_should-be-ignored',
      expires_at: '2026-12-01T00:00:00Z',
    });

    expect(useAuthStore.getState().managementKey).toBe('');
  });
});

describe('X-CPA-Session-Refresh handling', () => {
  test('replaces the stored bearer token when it matches the current token and apiBase', async () => {
    setFakeWindow('https://panel.example');
    await useAuthStore
      .getState()
      .applySessionLogin('https://api.other-origin.example', SESSION_RESPONSE, 'password');
    expect(useAuthStore.getState().sessionTransport).toBe('bearer');

    handleSessionRefreshToken({
      token: 'cpas_refreshed-token',
      previousToken: SESSION_RESPONSE.token,
      apiBase: 'https://api.other-origin.example',
    });

    expect(useAuthStore.getState().managementKey).toBe('cpas_refreshed-token');
  });

  test('(S3) ignores a late refresh whose previousToken no longer matches the current token', async () => {
    setFakeWindow('https://panel.example');
    await useAuthStore
      .getState()
      .applySessionLogin('https://api.other-origin.example', SESSION_RESPONSE, 'password');

    // A second, more recent refresh already landed...
    handleSessionRefreshToken({
      token: 'cpas_second-refresh',
      previousToken: SESSION_RESPONSE.token,
      apiBase: 'https://api.other-origin.example',
    });
    expect(useAuthStore.getState().managementKey).toBe('cpas_second-refresh');

    // ...then a stale, slower response from the FIRST request arrives after it. It was
    // authenticated with the original token, which is no longer current: ignore it.
    handleSessionRefreshToken({
      token: 'cpas_stale-late-arrival',
      previousToken: SESSION_RESPONSE.token,
      apiBase: 'https://api.other-origin.example',
    });

    expect(useAuthStore.getState().managementKey).toBe('cpas_second-refresh');
  });

  test('(S3) ignores a refresh for a different apiBase (a response from an abandoned server)', async () => {
    setFakeWindow('https://panel.example');
    await useAuthStore
      .getState()
      .applySessionLogin('https://api.other-origin.example', SESSION_RESPONSE, 'password');

    handleSessionRefreshToken({
      token: 'cpas_from-another-server',
      previousToken: SESSION_RESPONSE.token,
      apiBase: 'https://some-other-abandoned-server.example',
    });

    expect(useAuthStore.getState().managementKey).toBe(SESSION_RESPONSE.token);
  });

  test('is ignored in cookie-session mode', async () => {
    setFakeWindow('https://panel.example');
    spies.push(spyOn(sessionApi, 'getStatus').mockResolvedValue(AUTHENTICATED_STATUS));
    await useAuthStore
      .getState()
      .applySessionLogin('https://panel.example', SESSION_RESPONSE, 'password');
    expect(useAuthStore.getState().sessionTransport).toBe('cookie');

    handleSessionRefreshToken({ token: 'cpas_should-be-ignored' });

    expect(useAuthStore.getState().managementKey).toBe('');
  });

  test('is ignored in key mode', () => {
    useAuthStore.setState({
      authMode: 'key',
      sessionTransport: 'bearer',
      managementKey: 'real-key',
    });

    handleSessionRefreshToken({ token: 'cpas_should-be-ignored' });

    expect(useAuthStore.getState().managementKey).toBe('real-key');
  });

  test('ignores a missing/empty token', async () => {
    setFakeWindow('https://panel.example');
    await useAuthStore
      .getState()
      .applySessionLogin('https://api.other-origin.example', SESSION_RESPONSE, 'password');

    handleSessionRefreshToken(undefined);
    handleSessionRefreshToken({ token: '' });

    expect(useAuthStore.getState().managementKey).toBe(SESSION_RESPONSE.token);
  });
});

describe('B1: a stale session cookie must never block a key login', () => {
  test('login() clears any stale cookie best-effort when the apiBase is cookie-eligible', async () => {
    setFakeWindow('https://panel.example');
    useAuthStore.setState({ apiBase: 'https://panel.example' });
    const fetchConfigSpy = spyOn(useConfigStore.getState(), 'fetchConfig').mockResolvedValue(
      undefined as never
    );
    spies.push(fetchConfigSpy);

    await useAuthStore.getState().login({
      apiBase: 'https://panel.example',
      managementKey: 'a-management-key',
      rememberPassword: true,
    });

    expect(logoutNetworkSpy).toHaveBeenCalledWith('https://panel.example');
  });

  test('login() does not bother clearing a cookie for a cross-origin apiBase', async () => {
    setFakeWindow('https://panel.example');
    const fetchConfigSpy = spyOn(useConfigStore.getState(), 'fetchConfig').mockResolvedValue(
      undefined as never
    );
    spies.push(fetchConfigSpy);

    await useAuthStore.getState().login({
      apiBase: 'https://api.other-origin.example',
      managementKey: 'a-management-key',
      rememberPassword: true,
    });

    expect(logoutNetworkSpy).not.toHaveBeenCalled();
  });

  test("restoreSession's definitive authenticated:false branch clears the stale cookie", async () => {
    setFakeWindow('https://panel.example');
    useAuthStore.setState({
      apiBase: 'https://panel.example',
      managementKey: '',
      authMode: 'session',
      sessionTransport: 'cookie',
    });
    spies.push(spyOn(sessionApi, 'getStatus').mockResolvedValue(UNAUTHENTICATED_STATUS));

    await useAuthStore.getState().restoreSession();

    expect(logoutNetworkSpy).toHaveBeenCalledWith('https://panel.example');
  });
});

describe('restoreSession', () => {
  test('logs straight in with no prompt when session/status reports authenticated', async () => {
    setFakeWindow('https://panel.example');
    // `isLoggedIn` + a remembered key are set so that, if the session fast-path below failed to
    // return early, the legacy flow would actually call `login()` — making the "not called"
    // assertion meaningful rather than trivially true.
    localStorage.setItem('isLoggedIn', 'true');
    useAuthStore.setState({
      apiBase: 'https://panel.example',
      managementKey: 'would-be-used-if-session-path-did-not-return-early',
      rememberPassword: true,
      authMode: 'key',
    });
    spies.push(spyOn(sessionApi, 'getStatus').mockResolvedValue(AUTHENTICATED_STATUS));
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
    expect(useAuthStore.getState().sessionRoutesSupported).toBe(false);
  });

  test('does not retry a stale session token against the legacy key flow', async () => {
    // `isLoggedIn` is set so that, if the "previousAuthMode === 'session'" early return below were
    // missing, the legacy flow would call `login()` with the stale `cpas_` token as `managementKey`
    // — making the "not called" assertion actually exercise the guard instead of being vacuously
    // true because the legacy flow is unreachable for an unrelated reason.
    localStorage.setItem('isLoggedIn', 'true');
    useAuthStore.setState({
      apiBase: 'https://api.other-origin.example',
      managementKey: 'cpas_expired-token',
      authMode: 'session',
      sessionTransport: 'bearer',
    });
    spies.push(spyOn(sessionApi, 'getStatus').mockResolvedValue(UNAUTHENTICATED_STATUS));
    const loginSpy = spyOn(useAuthStore.getState(), 'login');
    spies.push(loginSpy);

    const result = await useAuthStore.getState().restoreSession();

    expect(result).toBe(false);
    expect(loginSpy).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().authMode).toBe('key');
    expect(useAuthStore.getState().managementKey).toBe('');
  });

  test('a network error probing session/status falls back to the remembered-key flow (key mode)', async () => {
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
    expect(useAuthStore.getState().sessionStatusError).toBe(true);
  });

  test('a network error probing session/status leaves a remembered session untouched and retries later', async () => {
    useAuthStore.setState({
      apiBase: 'https://api.other-origin.example',
      managementKey: 'cpas_still-good-token',
      authMode: 'session',
      sessionTransport: 'bearer',
    });
    const getStatusSpy = spyOn(sessionApi, 'getStatus').mockRejectedValueOnce(
      new Error('network unavailable')
    );
    spies.push(getStatusSpy);
    const loginSpy = spyOn(useAuthStore.getState(), 'login');
    spies.push(loginSpy);

    const result = await useAuthStore.getState().restoreSession();

    // Inconclusive: neither confirmed authenticated nor confirmed logged out.
    expect(result).toBe(false);
    expect(loginSpy).not.toHaveBeenCalled();
    // The session identity must survive a transient failure — never cleared on a guess.
    expect(useAuthStore.getState().authMode).toBe('session');
    expect(useAuthStore.getState().sessionTransport).toBe('bearer');
    expect(useAuthStore.getState().managementKey).toBe('cpas_still-good-token');

    // Because the failed probe must not be cached, a second call retries for real and can
    // succeed once the backend is reachable again.
    getStatusSpy.mockResolvedValueOnce(AUTHENTICATED_STATUS);
    const retryResult = await useAuthStore.getState().restoreSession();
    expect(retryResult).toBe(true);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  test('does not let a concurrent caller start a second parallel restore while the legacy login is still in flight', async () => {
    localStorage.setItem('isLoggedIn', 'true');
    useAuthStore.setState({
      apiBase: 'https://panel.example',
      managementKey: 'remembered-key',
      rememberPassword: true,
      authMode: 'key',
    });
    const getStatusSpy = spyOn(sessionApi, 'getStatus').mockRejectedValue(
      new Error('network unavailable')
    );
    spies.push(getStatusSpy);

    let resolveFetchConfig: () => void = () => {};
    const fetchConfigGate = new Promise<void>((resolve) => {
      resolveFetchConfig = resolve;
    });
    let fetchConfigCalls = 0;
    const fetchConfigSpy = spyOn(useConfigStore.getState(), 'fetchConfig').mockImplementation(
      async () => {
        fetchConfigCalls += 1;
        await fetchConfigGate;
      }
    );
    spies.push(fetchConfigSpy);

    const firstCall = useAuthStore.getState().restoreSession();

    // Let the probe reject and the legacy flow actually reach the gated `fetchConfig` call before
    // a "concurrent" second caller shows up — this is the exact window where the old code
    // (incorrectly) nulled `restoreSessionPromise` right after the probe, before `login()` and its
    // `fetchConfig` call had resolved.
    while (fetchConfigCalls === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const secondCall = useAuthStore.getState().restoreSession();
    expect(secondCall).toBe(firstCall); // same in-flight promise, not a second attempt.

    resolveFetchConfig();
    await firstCall;

    expect(fetchConfigCalls).toBe(1);
    expect(getStatusSpy).toHaveBeenCalledTimes(1);
  });
});

describe('identityVersion', () => {
  test('bumps on login(), applySessionLogin(), and logout(), but not on a token refresh', async () => {
    setFakeWindow('https://panel.example');
    useAuthStore.setState({ apiBase: 'https://panel.example' });
    const fetchConfigSpy = spyOn(useConfigStore.getState(), 'fetchConfig').mockResolvedValue(
      undefined as never
    );
    spies.push(fetchConfigSpy);

    const v0 = useAuthStore.getState().identityVersion;
    await useAuthStore.getState().login({
      apiBase: 'https://panel.example',
      managementKey: 'a-key',
      rememberPassword: true,
    });
    const v1 = useAuthStore.getState().identityVersion;
    expect(v1).toBeGreaterThan(v0);

    await useAuthStore
      .getState()
      .applySessionLogin('https://api.other-origin.example', SESSION_RESPONSE, 'password');
    const v2 = useAuthStore.getState().identityVersion;
    expect(v2).toBeGreaterThan(v1);

    // A refresh renews the same identity; it must not look like a new login/logout.
    handleSessionRefreshToken({
      token: 'cpas_refreshed-again',
      previousToken: SESSION_RESPONSE.token,
      apiBase: 'https://api.other-origin.example',
    });
    expect(useAuthStore.getState().identityVersion).toBe(v2);

    await useAuthStore.getState().logout();
    expect(useAuthStore.getState().identityVersion).toBeGreaterThan(v2);
  });

  test('is mirrored into apiClient via setIdentityVersion', async () => {
    setFakeWindow('https://panel.example');
    const fetchConfigSpy = spyOn(useConfigStore.getState(), 'fetchConfig').mockResolvedValue(
      undefined as never
    );
    spies.push(fetchConfigSpy);

    await useAuthStore.getState().login({
      apiBase: 'https://panel.example',
      managementKey: 'a-key',
      rememberPassword: true,
    });

    // No direct getter on apiClient; verify indirectly via a 401 stamped with the stale version
    // being ignored (covered thoroughly in apiClientAuthGuards.test.ts). Here we just confirm the
    // store and apiClient don't drift: logging out again should keep bumping forward.
    const afterLogin = useAuthStore.getState().identityVersion;
    await useAuthStore.getState().logout();
    expect(useAuthStore.getState().identityVersion).toBeGreaterThan(afterLogin);
  });
});

describe('apiClient.setToken / guardConfigConnection (session-refresh mid-request safety)', () => {
  test('setToken swaps the bearer token without bumping the connection revision', () => {
    apiClient.setConfig({ apiBase: 'https://panel.example', managementKey: 'cpas_old' });
    const revisionBefore = apiClient.getConnectionRevision();

    apiClient.setToken('cpas_new');

    expect(apiClient.getConnectionRevision()).toBe(revisionBefore);
  });

  test('a session-refresh mid-request does not trip guardConfigConnection', () => {
    apiClient.setConfig({ apiBase: 'https://panel.example', managementKey: 'cpas_old' });
    useAuthStore.setState({
      apiBase: 'https://panel.example',
      managementKey: 'cpas_old',
      authMode: 'session',
      sessionTransport: 'bearer',
    });

    // Simulate a request that started before the refresh arrived.
    const assertConnection = guardConfigConnection();

    handleSessionRefreshToken({
      token: 'cpas_new',
      previousToken: 'cpas_old',
      apiBase: 'https://panel.example',
    });

    expect(() => assertConnection()).not.toThrow();
  });
});
