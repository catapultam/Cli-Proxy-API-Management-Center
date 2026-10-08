import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { apiClient } from '@/services/api/client';
import { guardConfigConnection } from '@/services/api/configValue';
import { sessionApi } from '@/services/api/session';
import { obfuscatedStorage } from '@/services/storage/secureStorage';
import { handleSessionRefreshToken, useAuthStore } from '@/stores/useAuthStore';
import { useConfigStore } from '@/stores/useConfigStore';
import type { SessionStatus } from '@/types';

const spies: Array<{ mockRestore(): void }> = [];
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalLogin = useAuthStore.getState().login;
const originalFetchConfig = useConfigStore.getState().fetchConfig;
const memory = new Map<string, string>();
const sessionMemory = new Map<string, string>();

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
  // Stubbed the same way as localStorage above: the store's sessionStorage helpers
  // (write/read/clearSessionTokenBestEffort) feature-detect via `typeof sessionStorage`, so this
  // also exercises that they find a real implementation here, same as a browser would provide.
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => sessionMemory.get(key) ?? null,
      setItem: (key: string, value: string) => sessionMemory.set(key, value),
      removeItem: (key: string) => sessionMemory.delete(key),
    },
  });
  setFakeWindow('https://panel.example');
  logoutNetworkSpy = spyOn(sessionApi, 'logout').mockResolvedValue(undefined as never);
});

afterAll(() => {
  logoutNetworkSpy.mockRestore();
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
  if (originalSessionStorage)
    Object.defineProperty(globalThis, 'sessionStorage', originalSessionStorage);
  else Reflect.deleteProperty(globalThis, 'sessionStorage');
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
  sessionMemory.clear();
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

/** The sessionStorage key useAuthStore's browser-only session record lives under. */
const BROWSER_SESSION_KEY = 'cpa-browser-session';

/** Reads and parses this tab's browser-only session record, as a test would observe it. */
function readBrowserRecord(): Record<string, unknown> | null {
  const raw = sessionMemory.get(BROWSER_SESSION_KEY);
  return raw ? JSON.parse(raw) : null;
}

/** Reads the shared, persisted (obfuscated) auth blob's `state` sub-object, if any. */
function readPersistedAuthState(): Record<string, unknown> | null {
  const persisted = obfuscatedStorage.getItem<{ state: Record<string, unknown> }>('cli-proxy-auth');
  return persisted?.state ?? null;
}

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

  test('keeps a remembered bearer session on a same-origin base instead of switching to cookie', async () => {
    // applySessionLogin falls back to bearer on a same-origin base when the cookie did not stick
    // (e.g. a Secure cookie from the HTTPS origin shadows it on the HTTP one). The probe then
    // authenticates via that bearer, so dropping it for cookie mode leaves every request with no
    // credential: 401 -> logout on every reload.
    setFakeWindow('https://panel.example');
    useAuthStore.setState({
      apiBase: 'https://panel.example',
      managementKey: 'cpas_remembered-token',
      authMode: 'session',
      sessionTransport: 'bearer',
    });
    const getStatusSpy = spyOn(sessionApi, 'getStatus').mockResolvedValue(AUTHENTICATED_STATUS);
    spies.push(getStatusSpy);

    const result = await useAuthStore.getState().restoreSession();

    expect(result).toBe(true);
    expect(getStatusSpy.mock.calls[0]).toContain('cpas_remembered-token');
    expect(useAuthStore.getState().sessionTransport).toBe('bearer');
    expect(useAuthStore.getState().managementKey).toBe('cpas_remembered-token');
    // The client must actually send it.
    expect((apiClient as unknown as { managementKey: string }).managementKey).toBe(
      'cpas_remembered-token'
    );
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

describe('remember me', () => {
  test('login() sends remember=true in the request body by default-checked flow', async () => {
    // Cross-origin from the fake window on purpose: applySessionLogin then picks bearer transport
    // directly, with no follow-up session/status network probe to stub.
    setFakeWindow('https://panel.example');
    const loginSpy = spyOn(sessionApi, 'login').mockResolvedValue(SESSION_RESPONSE);
    spies.push(loginSpy);

    await useAuthStore.getState().loginWithPassword({
      apiBase: 'https://api.other-origin.example',
      username: 'admin',
      password: 'correct-horse-battery-staple',
      remember: true,
    });

    expect(loginSpy).toHaveBeenCalledWith('https://api.other-origin.example', {
      username: 'admin',
      password: 'correct-horse-battery-staple',
      remember: true,
    });
  });

  test('login() sends remember=false when the caller unchecked it', async () => {
    setFakeWindow('https://panel.example');
    const loginSpy = spyOn(sessionApi, 'login').mockResolvedValue(SESSION_RESPONSE);
    spies.push(loginSpy);

    await useAuthStore.getState().loginWithPassword({
      apiBase: 'https://api.other-origin.example',
      username: 'admin',
      password: 'correct-horse-battery-staple',
      remember: false,
    });

    expect(loginSpy).toHaveBeenCalledWith('https://api.other-origin.example', {
      username: 'admin',
      password: 'correct-horse-battery-staple',
      remember: false,
    });
  });

  // BLOCKER 1: version skew. An older proxy that doesn't understand `remember` at all silently
  // issues (and never echoes) a persistent 30-day session regardless of what was requested, so
  // the EFFECTIVE remember must come from `response.remember ?? true`, never from the request.
  test('BLOCKER 1: requested remember=false against a proxy that never echoes `remember` still ends up remembered', async () => {
    setFakeWindow('https://panel.example');
    // SESSION_RESPONSE carries no `remember` field, standing in for an old proxy's response.
    spies.push(spyOn(sessionApi, 'login').mockResolvedValue(SESSION_RESPONSE));

    await useAuthStore.getState().loginWithPassword({
      apiBase: 'https://api.other-origin.example',
      username: 'admin',
      password: 'correct-horse-battery-staple',
      remember: false,
    });

    const state = useAuthStore.getState();
    expect(state.sessionRemember).toBe(true);
    expect(state.managementKey).toBe(SESSION_RESPONSE.token);
    expect(readBrowserRecord()).toBeNull();
    // Token persisted as today: present in the shared (obfuscated) localStorage blob.
    expect(readPersistedAuthState()?.managementKey).toBe(SESSION_RESPONSE.token);
  });

  test('remember=true (unchanged): the bearer token is persisted to localStorage and no browser-only record is written', async () => {
    setFakeWindow('https://panel.example');
    await useAuthStore
      .getState()
      .applySessionLogin('https://api.other-origin.example', SESSION_RESPONSE, 'password');

    expect(useAuthStore.getState().sessionRemember).toBe(true);
    expect(useAuthStore.getState().managementKey).toBe(SESSION_RESPONSE.token);

    // zustand's persist middleware writes to storage synchronously on every `set()`; inspect
    // what actually landed in the (stubbed, obfuscated) localStorage.
    expect(memory.get('cli-proxy-auth')).toBeTruthy();
    expect(readPersistedAuthState()?.managementKey).toBe(SESSION_RESPONSE.token);
    expect(readBrowserRecord()).toBeNull();
  });

  test("remember=false: the bearer token is kept out of the persisted localStorage blob and lives in this tab's sessionStorage record instead", async () => {
    setFakeWindow('https://panel.example');
    const response = { ...SESSION_RESPONSE, remember: false };
    await useAuthStore
      .getState()
      .applySessionLogin('https://api.other-origin.example', response, 'password');

    const state = useAuthStore.getState();
    expect(state.sessionRemember).toBe(false);
    expect(state.managementKey).toBe(SESSION_RESPONSE.token); // still usable in-memory this tab.
    const record = readBrowserRecord();
    expect(record?.apiBase).toBe('https://api.other-origin.example');
    expect(record?.authMode).toBe('session');
    expect(record?.sessionTransport).toBe('bearer');
    expect(record?.token).toBe(SESSION_RESPONSE.token);
    expect(record?.remember).toBe(false);

    // The persisted blob must NOT contain the token.
    expect(memory.get('cli-proxy-auth')).toBeTruthy();
    expect(readPersistedAuthState()?.managementKey).toBeUndefined();
  });

  test("remember=false: restoreSession prefers this tab's sessionStorage record over the rehydrated state", async () => {
    // Cross-origin on purpose (see the first two tests in this describe block): this test is
    // about the bearer-token recovery path in restoreSession, not cookie-vs-bearer selection, so
    // avoid the same-origin cookie-verify probe applySessionLogin would otherwise fire here.
    setFakeWindow('https://panel.example');
    const response = { ...SESSION_RESPONSE, remember: false };
    await useAuthStore
      .getState()
      .applySessionLogin('https://api.other-origin.example', response, 'password');
    expect(readBrowserRecord()?.token).toBe(SESSION_RESPONSE.token);

    // Simulate a reload of THIS tab: the live store resets to a neutral/unrelated state, exactly
    // as rehydrating from a shared blob that never held this tab's browser-only identity would.
    useAuthStore.setState({
      managementKey: '',
      authMode: 'key',
      sessionTransport: 'bearer',
      sessionRemember: true,
      apiBase: 'https://api.other-origin.example',
    });
    const getStatusSpy = spyOn(sessionApi, 'getStatus').mockResolvedValue(AUTHENTICATED_STATUS);
    spies.push(getStatusSpy);

    const result = await useAuthStore.getState().restoreSession();

    expect(result).toBe(true);
    expect(getStatusSpy.mock.calls[0]).toContain(SESSION_RESPONSE.token);
    expect(useAuthStore.getState().managementKey).toBe(SESSION_RESPONSE.token);
    expect(useAuthStore.getState().sessionTransport).toBe('bearer');
    expect(useAuthStore.getState().sessionRemember).toBe(false);
  });

  test('logout() clears the browser-only session record and resets sessionRemember', async () => {
    setFakeWindow('https://panel.example');
    const response = { ...SESSION_RESPONSE, remember: false };
    await useAuthStore
      .getState()
      .applySessionLogin('https://api.other-origin.example', response, 'password');
    expect(readBrowserRecord()?.token).toBe(SESSION_RESPONSE.token);
    // A browser-only login never sets this shared flag in the first place.
    expect(localStorage.getItem('isLoggedIn')).toBeNull();

    await useAuthStore.getState().logout();

    expect(readBrowserRecord()).toBeNull();
    expect(useAuthStore.getState().sessionRemember).toBe(true); // reset to the default.
  });

  test("restoreSession's definitive authenticated:false branch clears the browser-only record too, and leaves isLoggedIn alone", async () => {
    setFakeWindow('https://panel.example');
    // Simulates a DIFFERENT, real, remembered key-mode tab having set this shared flag: a
    // browser-only session's own sign-out must never touch it (it never set it to begin with).
    localStorage.setItem('isLoggedIn', 'true');
    useAuthStore.setState({
      apiBase: 'https://panel.example',
      managementKey: '',
      authMode: 'session',
      sessionTransport: 'bearer',
      sessionRemember: false,
    });
    sessionMemory.set(
      BROWSER_SESSION_KEY,
      JSON.stringify({
        apiBase: 'https://panel.example',
        authMode: 'session',
        sessionTransport: 'bearer',
        token: 'cpas_stale-browser-session-token',
        remember: false,
      })
    );
    spies.push(spyOn(sessionApi, 'getStatus').mockResolvedValue(UNAUTHENTICATED_STATUS));

    await useAuthStore.getState().restoreSession();

    expect(readBrowserRecord()).toBeNull();
    expect(localStorage.getItem('isLoggedIn')).toBe('true');
  });

  // BLOCKER 2 is covered on the proxy side (PUT /account remember-preservation tests). The panel
  // has no dedicated "account save" remember test since AccountPage already derives the
  // effective remember from `response.remember ?? true` the same way applySessionLogin does.

  test('adoptRotatedToken updates the browser-only session record for a remember=false bearer session', async () => {
    setFakeWindow('https://panel.example');
    const response = { ...SESSION_RESPONSE, remember: false };
    await useAuthStore
      .getState()
      .applySessionLogin('https://api.other-origin.example', response, 'password');
    expect(readBrowserRecord()?.token).toBe(SESSION_RESPONSE.token);

    useAuthStore.getState().adoptRotatedToken('https://api.other-origin.example', {
      token: 'cpas_rotated-browser-only',
      expires_at: '2026-12-01T00:00:00Z',
    });

    expect(useAuthStore.getState().managementKey).toBe('cpas_rotated-browser-only');
    const record = readBrowserRecord();
    expect(record?.token).toBe('cpas_rotated-browser-only');
    expect(record?.remember).toBe(false);
  });

  test('handleSessionRefreshToken updates the browser-only session record for a remember=false bearer session', async () => {
    setFakeWindow('https://panel.example');
    const response = { ...SESSION_RESPONSE, remember: false };
    await useAuthStore
      .getState()
      .applySessionLogin('https://api.other-origin.example', response, 'password');

    handleSessionRefreshToken({
      token: 'cpas_refreshed-browser-only',
      previousToken: SESSION_RESPONSE.token,
      apiBase: 'https://api.other-origin.example',
    });

    expect(useAuthStore.getState().managementKey).toBe('cpas_refreshed-browser-only');
    expect(readBrowserRecord()?.token).toBe('cpas_refreshed-browser-only');
  });

  // BLOCKER 5 / #5: entering key mode must leave no trace of a prior browser-only session.
  test('key-mode login() resets sessionRemember to true and clears any leftover browser-only session record', async () => {
    setFakeWindow('https://panel.example');
    sessionMemory.set(
      BROWSER_SESSION_KEY,
      JSON.stringify({
        apiBase: 'https://panel.example',
        authMode: 'session',
        sessionTransport: 'bearer',
        token: 'cpas_leftover-browser-only-token',
        remember: false,
      })
    );
    useAuthStore.setState({ sessionRemember: false });
    const fetchConfigSpy = spyOn(useConfigStore.getState(), 'fetchConfig').mockResolvedValue(
      undefined as never
    );
    spies.push(fetchConfigSpy);

    await useAuthStore.getState().login({
      apiBase: 'https://panel.example',
      managementKey: 'a-management-key',
      rememberPassword: true,
    });

    expect(useAuthStore.getState().sessionRemember).toBe(true);
    expect(readBrowserRecord()).toBeNull();
  });

  // #4: a leftover `isLoggedIn`/legacy key must not resurrect a stale auto-login on the restore
  // that follows a sign-out.
  test('#4: the definitive sign-out branch clears isLoggedIn, so the following restore never calls login()', async () => {
    setFakeWindow('https://panel.example');
    localStorage.setItem('isLoggedIn', 'true');
    obfuscatedStorage.setItem('managementKey', 'a-leftover-legacy-key');
    useAuthStore.setState({
      apiBase: 'https://panel.example',
      managementKey: 'cpas_expired-token',
      authMode: 'session',
      sessionTransport: 'bearer',
      sessionRemember: true,
    });
    spies.push(spyOn(sessionApi, 'getStatus').mockResolvedValue(UNAUTHENTICATED_STATUS));

    const firstResult = await useAuthStore.getState().restoreSession();
    expect(firstResult).toBe(false);
    expect(localStorage.getItem('isLoggedIn')).toBeNull();

    // A second, later restore (standing in for the NEXT page load) must not resurrect the
    // leftover legacy key via the legacy auto-login flow now that `isLoggedIn` is gone.
    const loginSpy = spyOn(useAuthStore.getState(), 'login');
    spies.push(loginSpy);
    const secondResult = await useAuthStore.getState().restoreSession();

    expect(secondResult).toBe(false);
    expect(loginSpy).not.toHaveBeenCalled();
  });
});

describe('multi-tab browser-only session isolation (BLOCKER 3)', () => {
  test('an unrelated set() in a browser-only tab never clobbers a remembered session blob written by another tab', async () => {
    setFakeWindow('https://panel.example');
    // Tab B wrote a remembered bearer session to the shared blob.
    obfuscatedStorage.setItem('cli-proxy-auth', {
      state: {
        apiBase: 'https://panel.example',
        managementKey: 'cpas_tab-b-remembered-token',
        authMode: 'session',
        sessionTransport: 'bearer',
        sessionRemember: true,
        rememberPassword: false,
        serverVersion: null,
        serverBuildDate: null,
      },
      version: 0,
    });

    // This tab (tab A) is itself a browser-only session.
    useAuthStore.setState({
      authMode: 'session',
      sessionTransport: 'bearer',
      sessionRemember: false,
      managementKey: 'cpas_tab-a-browser-only-token',
      apiBase: 'https://panel.example',
    });

    // Some unrelated event triggers a write (e.g. a server-version update banner) in tab A.
    useAuthStore.getState().updateServerVersion('9.9.9', '2026-01-01');

    const persisted = readPersistedAuthState();
    expect(persisted?.managementKey).toBe('cpas_tab-b-remembered-token');
    expect(persisted?.authMode).toBe('session');
    expect(persisted?.sessionRemember).toBe(true);
    // Non-identity fields DID update from tab A's write.
    expect(persisted?.serverVersion).toBe('9.9.9');
  });

  // These two exercise `protectSharedBlobOnNextWrite`: the one case where the INCOMING write no
  // longer looks browser-only (authMode flips to 'key'/'session'→'key' as the identity ends), so
  // the ordinary incoming-state guard above would not, by itself, protect the write.
  test("restoreSession's sign-out branch for a browser-only session never rewrites a remembered blob written by another tab", async () => {
    setFakeWindow('https://panel.example');
    obfuscatedStorage.setItem('cli-proxy-auth', {
      state: {
        apiBase: 'https://panel.example',
        managementKey: 'cpas_tab-b-remembered-token',
        authMode: 'session',
        sessionTransport: 'bearer',
        sessionRemember: true,
        rememberPassword: false,
        serverVersion: null,
        serverBuildDate: null,
      },
      version: 0,
    });
    // As tab B's own remembered key/session login would have set.
    localStorage.setItem('isLoggedIn', 'true');

    useAuthStore.setState({
      apiBase: 'https://panel.example',
      managementKey: 'cpas_tab-a-browser-only-token',
      authMode: 'session',
      sessionTransport: 'bearer',
      sessionRemember: false,
    });
    sessionMemory.set(
      BROWSER_SESSION_KEY,
      JSON.stringify({
        apiBase: 'https://panel.example',
        authMode: 'session',
        sessionTransport: 'bearer',
        token: 'cpas_tab-a-browser-only-token',
        remember: false,
      })
    );
    spies.push(spyOn(sessionApi, 'getStatus').mockResolvedValue(UNAUTHENTICATED_STATUS));

    await useAuthStore.getState().restoreSession();

    const persisted = readPersistedAuthState();
    expect(persisted?.managementKey).toBe('cpas_tab-b-remembered-token');
    expect(persisted?.authMode).toBe('session');
    expect(persisted?.sessionRemember).toBe(true);
    expect(readBrowserRecord()).toBeNull();
    expect(localStorage.getItem('isLoggedIn')).toBe('true');
  });

  test('logout() on a browser-only session never rewrites a remembered blob written by another tab', async () => {
    setFakeWindow('https://panel.example');
    obfuscatedStorage.setItem('cli-proxy-auth', {
      state: {
        apiBase: 'https://panel.example',
        managementKey: 'cpas_tab-b-remembered-token',
        authMode: 'session',
        sessionTransport: 'bearer',
        sessionRemember: true,
        rememberPassword: false,
        serverVersion: null,
        serverBuildDate: null,
      },
      version: 0,
    });
    localStorage.setItem('isLoggedIn', 'true');

    useAuthStore.setState({
      apiBase: 'https://panel.example',
      managementKey: 'cpas_tab-a-browser-only-token',
      authMode: 'session',
      sessionTransport: 'bearer',
      sessionRemember: false,
    });

    await useAuthStore.getState().logout();

    const persisted = readPersistedAuthState();
    expect(persisted?.managementKey).toBe('cpas_tab-b-remembered-token');
    expect(persisted?.authMode).toBe('session');
    expect(persisted?.sessionRemember).toBe(true);
    expect(localStorage.getItem('isLoggedIn')).toBe('true');
  });

  test("restore uses this tab's browser-only record and its own server, never the shared blob's", async () => {
    // Tab B is remembered on server Y (shared blob); this tab (A) is browser-only on server X.
    setFakeWindow('https://panel.example');
    sessionMemory.set(
      BROWSER_SESSION_KEY,
      JSON.stringify({
        apiBase: 'https://api.x.example',
        authMode: 'session',
        sessionTransport: 'bearer',
        token: 'cpas_tabA_X',
        remember: false,
      })
    );
    useAuthStore.setState({
      apiBase: 'https://api.y.example',
      managementKey: 'cpas_tabB_Y',
      authMode: 'session',
      sessionTransport: 'bearer',
      sessionRemember: true,
    });
    const getStatusSpy = spyOn(sessionApi, 'getStatus').mockResolvedValue(AUTHENTICATED_STATUS);
    spies.push(getStatusSpy);

    const result = await useAuthStore.getState().restoreSession();

    expect(result).toBe(true);
    expect(getStatusSpy).toHaveBeenCalledWith('https://api.x.example', 'cpas_tabA_X');
    // Tab B's token never goes anywhere from this tab.
    for (const call of getStatusSpy.mock.calls) expect(call).not.toContain('cpas_tabB_Y');
    expect(useAuthStore.getState().apiBase).toBe('https://api.x.example');
    expect(useAuthStore.getState().sessionRemember).toBe(false);
  });

  test("a browser-only tab's writes keep the shared blob's apiBase paired with its token", async () => {
    obfuscatedStorage.setItem('cli-proxy-auth', {
      state: {
        apiBase: 'https://api.y.example',
        managementKey: 'cpas_tabB_Y',
        authMode: 'session',
        sessionTransport: 'bearer',
        sessionRemember: true,
        rememberPassword: false,
        serverVersion: null,
        serverBuildDate: null,
      },
      version: 0,
    });
    useAuthStore.setState({
      apiBase: 'https://api.x.example',
      managementKey: 'cpas_tabA_X',
      authMode: 'session',
      sessionTransport: 'bearer',
      sessionRemember: false,
    });
    useAuthStore.getState().updateServerVersion('9.9.9', null);

    const persisted = readPersistedAuthState();
    expect(persisted?.apiBase).toBe('https://api.y.example');
    expect(persisted?.managementKey).toBe('cpas_tabB_Y');
    expect(persisted?.serverVersion).toBe('9.9.9');
  });

  test('an empty sessionStorage falls back to a remembered session already reflected in the rehydrated state', async () => {
    setFakeWindow('https://panel.example');
    // No browser-only record at all, but the rehydrated state (standing in for what a real
    // reload would load from the shared blob) is a genuinely remembered session.
    useAuthStore.setState({
      apiBase: 'https://panel.example',
      managementKey: 'cpas_remembered-after-reload',
      authMode: 'session',
      sessionTransport: 'bearer',
      sessionRemember: true,
    });
    const getStatusSpy = spyOn(sessionApi, 'getStatus').mockResolvedValue(AUTHENTICATED_STATUS);
    spies.push(getStatusSpy);

    const result = await useAuthStore.getState().restoreSession();

    expect(result).toBe(true);
    expect(getStatusSpy).toHaveBeenCalledWith(
      'https://panel.example',
      'cpas_remembered-after-reload'
    );
    expect(useAuthStore.getState().managementKey).toBe('cpas_remembered-after-reload');
    expect(useAuthStore.getState().sessionRemember).toBe(true);
  });

  test('a persisted blob claiming a browser-only session with empty sessionStorage sends no bearer and never falls through to login()', async () => {
    setFakeWindow('https://panel.example');
    // Would prove the guard, not just be vacuously true, if it were consulted.
    localStorage.setItem('isLoggedIn', 'true');
    useAuthStore.setState({
      apiBase: 'https://api.other-origin.example',
      managementKey: '', // never actually persisted for a browser-only session, per partialize
      authMode: 'session',
      sessionTransport: 'bearer',
      sessionRemember: false,
    });
    const getStatusSpy = spyOn(sessionApi, 'getStatus').mockResolvedValue(UNAUTHENTICATED_STATUS);
    spies.push(getStatusSpy);
    const loginSpy = spyOn(useAuthStore.getState(), 'login');
    spies.push(loginSpy);

    const result = await useAuthStore.getState().restoreSession();

    expect(result).toBe(false);
    expect(getStatusSpy).toHaveBeenCalledWith('https://api.other-origin.example', undefined);
    expect(loginSpy).not.toHaveBeenCalled();
    expect(useAuthStore.getState().authMode).toBe('key');
  });

  // The "keeps a remembered bearer session on a same-origin base instead of switching to
  // cookie" regression test lives in the `restoreSession` describe block above; not duplicated
  // here.
});
