/**
 * 认证状态管理
 * 从原项目 src/modules/login.js 和 src/core/connection.js 迁移
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type {
  AuthState,
  LoginCredentials,
  ConnectionStatus,
  SessionTransport,
  SessionResponse,
  SessionStatus,
  SessionLoginMethod,
} from '@/types';
import { STORAGE_KEY_AUTH } from '@/utils/constants';
import { obfuscatedStorage } from '@/services/storage/secureStorage';
import { apiClient } from '@/services/api/client';
import { sessionApi } from '@/services/api/session';
import { LegacyBackendError, probeLegacyBackend } from '@/services/api/legacyBackendProbe';
import { useConfigStore } from './useConfigStore';
import { useModelsStore } from './useModelsStore';
import { useQuotaStore } from './useQuotaStore';
import { detectApiBaseFromLocation, isCookieEligible, normalizeApiBase } from '@/utils/connection';

interface AuthStoreState extends AuthState {
  connectionStatus: ConnectionStatus;
  /**
   * Last known `session/status` response for the current `apiBase`. Populated by
   * `restoreSession`/`refreshSessionStatus`, consumed by `LoginPage` to decide which form to
   * show. `null` means the endpoint is unavailable (old backend) or has not been checked yet.
   */
  sessionStatus: SessionStatus | null;
  /** True when the last `session/status` probe failed to reach the backend at all (network/5xx/
   * timeout) rather than giving a definitive answer. Distinguishes "no account" from "couldn't
   * tell" so the login page can offer a retry instead of silently falling back to the key form. */
  sessionStatusError: boolean;
  /** `false` only once a `session/status` probe has definitively 404'd (an old backend with no
   * session routes at all). Starts `true` (optimistic) so the Account nav entry doesn't flash
   * away before the first probe completes. */
  sessionRoutesSupported: boolean;
  /**
   * Bumped only when the *identity* behind the connection actually changes (a new login, a
   * restored session, or a logout) — never by a sliding-session token refresh. Callers that need
   * to detect "did the logged-in party change under me" (stale-request guards, per-identity
   * caches) should compare this instead of `managementKey`, which now also changes on a refresh
   * that still represents the same session.
   */
  identityVersion: number;

  // 操作
  login: (credentials: LoginCredentials) => Promise<void>;
  loginWithPassword: (params: {
    apiBase: string;
    username: string;
    password: string;
  }) => Promise<void>;
  applySessionLogin: (
    apiBase: string,
    response: SessionResponse,
    method: SessionLoginMethod
  ) => Promise<void>;
  /**
   * Adopts a fresh token for the SAME already-logged-in identity (e.g. a password change rotates
   * `session-secret`, which issues a new token so the caller stays logged in). Unlike
   * `applySessionLogin`, this never clears the config/models/quota caches and never bumps
   * `identityVersion`: nothing about who is logged in changed, only the token value.
   */
  adoptRotatedToken: (apiBase: string, response: SessionResponse) => void;
  refreshSessionStatus: (apiBaseOverride?: string) => Promise<SessionStatus | null>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<boolean>;
  restoreSession: () => Promise<boolean>;
  updateServerVersion: (version: string | null, buildDate?: string | null) => void;
  updateServerPluginSupport: (supportsPlugin: boolean) => void;
}

let restoreSessionPromise: Promise<boolean> | null = null;

/** Dedupes the best-effort "clear any stale session cookie" POST across concurrent callers. */
let pendingSessionLogoutRequest: Promise<void> | null = null;

/**
 * Fires `POST session/logout` best-effort: never throws, and the caller never awaits it (clearing
 * local state must not wait on a network round trip). Deduped so concurrent callers (e.g. a 401
 * on several parallel requests) only produce one request in flight.
 */
function fireSessionLogoutBestEffort(apiBase: string): void {
  if (!apiBase || pendingSessionLogoutRequest) return;
  pendingSessionLogoutRequest = sessionApi
    .logout(apiBase)
    .catch(() => {
      // Best-effort: nothing to recover from here.
    })
    .finally(() => {
      pendingSessionLogoutRequest = null;
    });
}

/**
 * B1: a stale `cpa_mgmt_session` cookie must never block a subsequent key login or linger after a
 * session is confirmed gone. Only meaningful when a cookie could exist at all (same-origin, root
 * path) — on a bearer-only apiBase there is nothing to clear.
 */
function clearStaleCookieBestEffort(apiBase: string): void {
  if (!isCookieEligible(apiBase)) return;
  fireSessionLogoutBestEffort(apiBase);
}

type SessionStatusProbe =
  | { kind: 'ok'; status: SessionStatus }
  | { kind: 'not-found' } // 404: an old backend with no session routes at all.
  | { kind: 'error' }; // network failure, 5xx, or anything else inconclusive.

/**
 * Probes `session/status` without ever throwing, distinguishing a definitive answer (200, or a
 * 404 meaning "this backend has no session support") from an inconclusive one (network error,
 * 5xx, timeout). Callers must only persist an identity change on a definitive answer; an
 * inconclusive probe must leave the stored auth mode and token untouched so a retry can succeed.
 */
async function probeSessionStatus(
  apiBase: string,
  bearerToken?: string
): Promise<SessionStatusProbe> {
  if (!apiBase) return { kind: 'error' };
  try {
    const status = await sessionApi.getStatus(apiBase, bearerToken);
    return { kind: 'ok', status };
  } catch (error) {
    if ((error as { status?: number })?.status === 404) return { kind: 'not-found' };
    return { kind: 'error' };
  }
}

/** Thin wrapper for call sites (e.g. the Advanced apiBase field) that only need the status or null. */
async function fetchSessionStatusSafely(
  apiBase: string,
  bearerToken?: string
): Promise<SessionStatus | null> {
  const probe = await probeSessionStatus(apiBase, bearerToken);
  return probe.kind === 'ok' ? probe.status : null;
}

export const useAuthStore = create<AuthStoreState>()(
  persist(
    (set, get) => {
      /** Bumps identityVersion and mirrors it into `apiClient` (which cannot import this store). */
      const bumpIdentityVersion = (): number => {
        const next = get().identityVersion + 1;
        apiClient.setIdentityVersion(next);
        return next;
      };

      return {
        // 初始状态
        isAuthenticated: false,
        apiBase: '',
        managementKey: '',
        rememberPassword: false,
        serverVersion: null,
        serverBuildDate: null,
        supportsPlugin: false,
        connectionStatus: 'disconnected',
        authMode: 'key',
        sessionTransport: 'bearer',
        loginMethod: '',
        sessionStatus: null,
        sessionStatusError: false,
        sessionRoutesSupported: true,
        identityVersion: 0,

        // 恢复会话并自动登录
        restoreSession: () => {
          if (restoreSessionPromise) return restoreSessionPromise;

          restoreSessionPromise = (async () => {
            obfuscatedStorage.migratePlaintextKeys(['apiBase', 'apiUrl', 'managementKey']);

            const wasLoggedIn = localStorage.getItem('isLoggedIn') === 'true';
            const legacyBase =
              obfuscatedStorage.getItem<string>('apiBase') ||
              obfuscatedStorage.getItem<string>('apiUrl', { encrypt: true });
            const legacyKey = obfuscatedStorage.getItem<string>('managementKey');

            const { apiBase, managementKey, rememberPassword, authMode, sessionTransport } = get();
            const resolvedBase = normalizeApiBase(
              apiBase || legacyBase || detectApiBaseFromLocation()
            );

            // Check the new session-based login first: an authenticated cookie or a remembered
            // bearer-session token means we can log straight in with no prompt at all.
            const previousAuthMode = authMode;
            const bearerToken =
              previousAuthMode === 'session' && sessionTransport === 'bearer'
                ? managementKey
                : undefined;
            const probe = await probeSessionStatus(resolvedBase, bearerToken);
            set({ apiBase: resolvedBase });

            if (probe.kind === 'error') {
              // Inconclusive (network error, 5xx, timeout): never mutate the persisted identity
              // on a guess. Surface it so the login page can offer a retry instead of silently
              // showing the key-only form.
              set({ sessionStatusError: true });
              if (previousAuthMode === 'session') {
                // Nothing else pending for this attempt: safe to let the next call retry fresh.
                restoreSessionPromise = null;
                return false;
              }
              // Key-mode (the default/common case) falls through to the unchanged legacy flow
              // below, matching today's resilience: a transient probe failure must not block a
              // login that would otherwise succeed with an already-known-good management key.
              // Do NOT clear `restoreSessionPromise` here — the legacy flow below may still be
              // in flight (awaiting `login()`), and clearing it now would let a concurrent caller
              // kick off a second, parallel restore attempt.
            } else {
              set({
                sessionStatusError: false,
                sessionStatus: probe.kind === 'ok' ? probe.status : null,
                sessionRoutesSupported: probe.kind !== 'not-found',
              });

              if (probe.kind === 'ok' && probe.status.authenticated) {
                // A remembered bearer that just authenticated stays bearer: login only picks
                // bearer on a same-origin base when the cookie did not stick, so switching to
                // cookie here would send no credential at all.
                const transport: SessionTransport =
                  bearerToken || !isCookieEligible(resolvedBase) ? 'bearer' : 'cookie';
                const tokenForClient = transport === 'bearer' ? bearerToken || '' : '';
                apiClient.setConfig({ apiBase: resolvedBase, managementKey: tokenForClient });
                set({
                  isAuthenticated: true,
                  apiBase: resolvedBase,
                  managementKey: tokenForClient,
                  authMode: 'session',
                  sessionTransport: transport,
                  loginMethod: probe.status.method,
                  connectionStatus: 'connected',
                  identityVersion: bumpIdentityVersion(),
                });
                return true;
              }

              if (previousAuthMode === 'session') {
                // A definitive answer (200 authenticated:false, or 404 meaning the backend no
                // longer exposes session routes at all): the remembered session is confirmed
                // gone. `managementKey` here is a session token, not a real management key, so it
                // must never be retried against the legacy key flow below. Also clear the (same-
                // origin) cookie best-effort: the backend only clears it itself on a 401 from an
                // authenticated request, which this status check never made.
                clearStaleCookieBestEffort(resolvedBase);
                apiClient.setConfig({ apiBase: resolvedBase, managementKey: '' });
                set({
                  isAuthenticated: false,
                  managementKey: '',
                  authMode: 'key',
                  sessionTransport: 'bearer',
                  loginMethod: '',
                  connectionStatus: 'disconnected',
                  identityVersion: bumpIdentityVersion(),
                });
                return false;
              }
            }

            // Legacy remembered-key auto-login (unchanged behavior).
            const resolvedKey = managementKey || legacyKey || '';
            const resolvedRememberPassword =
              rememberPassword || Boolean(managementKey) || Boolean(legacyKey);

            set({
              apiBase: resolvedBase,
              managementKey: resolvedKey,
              rememberPassword: resolvedRememberPassword,
            });
            apiClient.setConfig({ apiBase: resolvedBase, managementKey: resolvedKey });

            if (wasLoggedIn && resolvedBase && resolvedKey) {
              try {
                await get().login({
                  apiBase: resolvedBase,
                  managementKey: resolvedKey,
                  rememberPassword: resolvedRememberPassword,
                });
                return true;
              } catch (error) {
                console.warn('Auto login failed:', error);
                return false;
              } finally {
                restoreSessionPromise = null;
              }
            }

            restoreSessionPromise = null;
            return false;
          })();

          return restoreSessionPromise;
        },

        // 刷新当前 apiBase 的 session/status（供登录页在用户修改 Advanced 连接地址后重新探测，或手动重试）
        refreshSessionStatus: async (apiBaseOverride) => {
          const base = normalizeApiBase(apiBaseOverride ?? get().apiBase);
          const probe = await probeSessionStatus(base);
          if (probe.kind === 'error') {
            set({ sessionStatusError: true });
            return null;
          }
          set({
            sessionStatusError: false,
            sessionStatus: probe.kind === 'ok' ? probe.status : null,
            sessionRoutesSupported: probe.kind !== 'not-found',
          });
          return probe.kind === 'ok' ? probe.status : null;
        },

        // 登录（管理密钥模式，今天的行为保持不变）
        login: async (credentials) => {
          const apiBase = normalizeApiBase(credentials.apiBase);
          const managementKey = credentials.managementKey.trim();
          const rememberPassword = credentials.rememberPassword ?? get().rememberPassword ?? false;

          // A stale session cookie must never block a key login: clear it best-effort first (it
          // is harmless/no-op if there is nothing to clear, e.g. on a non-cookie-eligible apiBase).
          clearStaleCookieBestEffort(apiBase);

          try {
            set({
              connectionStatus: 'connecting',
              serverVersion: null,
              serverBuildDate: null,
              supportsPlugin: false,
            });
            useConfigStore.getState().clearCache();
            useModelsStore.getState().clearCache();
            useQuotaStore.getState().clearQuotaCache();

            // 配置 API 客户端
            apiClient.setConfig({
              apiBase,
              managementKey,
            });

            // 测试连接 - 获取配置。只在 v8 路由不存在时诊断旧版后端。
            const revision = apiClient.getConnectionRevision();
            try {
              await useConfigStore.getState().fetchConfig(true);
            } catch (error) {
              if (
                (error as { status?: number })?.status === 404 &&
                revision === apiClient.getConnectionRevision() &&
                (await probeLegacyBackend(apiBase, managementKey)) &&
                revision === apiClient.getConnectionRevision()
              ) {
                throw new LegacyBackendError();
              }
              throw error;
            }

            // 登录成功
            set({
              isAuthenticated: true,
              apiBase,
              managementKey,
              rememberPassword,
              authMode: 'key',
              sessionTransport: 'bearer',
              loginMethod: 'key',
              connectionStatus: 'connected',
              identityVersion: bumpIdentityVersion(),
            });
            if (rememberPassword) {
              localStorage.setItem('isLoggedIn', 'true');
            } else {
              localStorage.removeItem('isLoggedIn');
            }
          } catch (error: unknown) {
            set({ connectionStatus: 'error' });
            throw error;
          }
        },

        // 用户名 + 密码登录（会话模式）
        loginWithPassword: async ({ apiBase, username, password }) => {
          const normalizedBase = normalizeApiBase(apiBase);
          set({ connectionStatus: 'connecting' });
          try {
            const response = await sessionApi.login(normalizedBase, { username, password });
            await get().applySessionLogin(normalizedBase, response, 'password');
          } catch (error) {
            set({ connectionStatus: 'error' });
            throw error;
          }
        },

        // 由密码或 passkey 登录成功后，统一落地会话状态（选择 cookie / bearer 传输方式）
        applySessionLogin: async (apiBase, response, method) => {
          const normalizedBase = normalizeApiBase(apiBase);
          let transport: SessionTransport = isCookieEligible(normalizedBase) ? 'cookie' : 'bearer';

          if (transport === 'cookie') {
            // Some browsers/privacy modes block first-party cookies even when same-origin.
            // Verify the cookie actually stuck before committing to cookie mode; fall back to the
            // bearer token we already have in hand if it didn't.
            const verify = await fetchSessionStatusSafely(normalizedBase);
            if (!verify?.authenticated) {
              transport = 'bearer';
            }
          }

          const tokenForClient = transport === 'bearer' ? response.token : '';

          useConfigStore.getState().clearCache();
          useModelsStore.getState().clearCache();
          useQuotaStore.getState().clearQuotaCache();

          apiClient.setConfig({ apiBase: normalizedBase, managementKey: tokenForClient });
          set({
            isAuthenticated: true,
            apiBase: normalizedBase,
            managementKey: tokenForClient,
            authMode: 'session',
            sessionTransport: transport,
            loginMethod: method,
            connectionStatus: 'connected',
            identityVersion: bumpIdentityVersion(),
          });
          localStorage.setItem('isLoggedIn', 'true');
        },

        adoptRotatedToken: (apiBase, response) => {
          const { sessionTransport, apiBase: currentApiBase } = get();
          // Cookie mode: the browser already applied the rotated token via Set-Cookie on the
          // response that carried it. Nothing for the client to do.
          if (sessionTransport !== 'bearer') return;
          const normalizedBase = normalizeApiBase(apiBase) || currentApiBase;
          if (normalizedBase !== currentApiBase) return; // defensive: never adopt across a switch.
          apiClient.setToken(response.token);
          set({ managementKey: response.token });
        },

        // 登出
        logout: async () => {
          restoreSessionPromise = null;
          const { authMode, apiBase } = get();

          // Clear local state FIRST — the caller should see "logged out" immediately rather than
          // waiting on a network round trip. The (best-effort, deduped) server-side logout fires
          // afterward and is never awaited.
          apiClient.setConfig({ apiBase: '', managementKey: '' });
          useConfigStore.getState().clearCache();
          useModelsStore.getState().clearCache();
          useQuotaStore.getState().clearQuotaCache();
          set({
            isAuthenticated: false,
            apiBase: '',
            managementKey: '',
            rememberPassword: false,
            serverVersion: null,
            serverBuildDate: null,
            supportsPlugin: false,
            connectionStatus: 'disconnected',
            authMode: 'key',
            sessionTransport: 'bearer',
            loginMethod: '',
            sessionStatus: null,
            identityVersion: bumpIdentityVersion(),
          });
          localStorage.removeItem('isLoggedIn');

          if (authMode === 'session' && apiBase) {
            fireSessionLogoutBestEffort(apiBase);
          }
        },

        // 检查认证状态
        checkAuth: async () => {
          const { managementKey, apiBase } = get();

          if (!managementKey || !apiBase) {
            return false;
          }

          try {
            // 重新配置客户端
            apiClient.setConfig({ apiBase, managementKey });
            set({ supportsPlugin: false });

            // 验证连接
            await useConfigStore.getState().fetchConfig();

            set({
              isAuthenticated: true,
              connectionStatus: 'connected',
            });

            return true;
          } catch {
            set({
              isAuthenticated: false,
              connectionStatus: 'error',
              supportsPlugin: false,
            });
            return false;
          }
        },

        // 更新服务器版本
        updateServerVersion: (version, buildDate) => {
          set({
            serverVersion: version || null,
            serverBuildDate: buildDate || null,
          });
        },

        updateServerPluginSupport: (supportsPlugin) => {
          set({ supportsPlugin });
        },
      };
    },
    {
      name: STORAGE_KEY_AUTH,
      storage: createJSONStorage(() => ({
        getItem: (name) => {
          const data = obfuscatedStorage.getItem<AuthStoreState>(name);
          return data ? JSON.stringify(data) : null;
        },
        setItem: (name, value) => {
          obfuscatedStorage.setItem(name, JSON.parse(value));
        },
        removeItem: (name) => {
          obfuscatedStorage.removeItem(name);
        },
      })),
      partialize: (state) => ({
        apiBase: state.apiBase,
        // Session mode persists its (revocable, 30-day) token regardless of `rememberPassword`,
        // which only gates the real management key. Without this split, forcing session logins to
        // flip `rememberPassword` just to survive a reload would also silently "remember" a key
        // the user never asked to remember.
        ...(state.authMode === 'session' || state.rememberPassword
          ? { managementKey: state.managementKey }
          : {}),
        rememberPassword: state.rememberPassword,
        serverVersion: state.serverVersion,
        serverBuildDate: state.serverBuildDate,
        authMode: state.authMode,
        sessionTransport: state.sessionTransport,
      }),
    }
  )
);

export interface SessionRefreshDetail {
  token: string;
  /** The bearer token the triggering request was authenticated with, if any. */
  previousToken?: string;
  /** The apiBase the triggering request was made against. */
  apiBase?: string;
}

/**
 * Sliding bearer-session renewal: `apiClient` dispatches a `session-refresh` window event when a
 * response carries `X-CPA-Session-Refresh`. Cookie-mode sessions renew via `Set-Cookie` instead
 * and never emit it. Exported (rather than inlined in the listener below) so it has a single,
 * directly testable entry point independent of whether `window` exists at module-load time.
 *
 * Ignores a refresh whose triggering request no longer matches the CURRENT identity: a late
 * response from a request made under an old token (already superseded by a newer refresh or a
 * fresh login) or a since-abandoned apiBase must not clobber the current session's token.
 */
export function handleSessionRefreshToken(detail: SessionRefreshDetail | null | undefined): void {
  if (!detail?.token) return;
  const state = useAuthStore.getState();
  if (state.authMode !== 'session' || state.sessionTransport !== 'bearer') return;
  if (detail.apiBase !== undefined && detail.apiBase !== state.apiBase) return;
  if (detail.previousToken !== undefined && detail.previousToken !== state.managementKey) return;
  apiClient.setToken(detail.token);
  useAuthStore.setState({ managementKey: detail.token });
}

// 监听全局未授权事件
if (typeof window !== 'undefined') {
  let handlingUnauthorized = false;
  window.addEventListener('unauthorized', () => {
    if (handlingUnauthorized) return; // dedupe: several parallel 401s must only log out once.
    handlingUnauthorized = true;
    const { apiBase } = useAuthStore.getState();
    // Regardless of the current auth mode: a stale cookie left over from a previous session
    // login must not linger once we know the credential it carries is no good.
    clearStaleCookieBestEffort(apiBase);
    Promise.resolve(useAuthStore.getState().logout()).finally(() => {
      handlingUnauthorized = false;
    });
  });

  window.addEventListener('server-version-update', ((e: CustomEvent) => {
    const detail = e.detail || {};
    useAuthStore.getState().updateServerVersion(detail.version || null, detail.buildDate || null);
  }) as EventListener);

  window.addEventListener('server-plugin-support-update', ((e: CustomEvent) => {
    useAuthStore.getState().updateServerPluginSupport(e.detail?.supportsPlugin === true);
  }) as EventListener);

  window.addEventListener('session-refresh', ((e: CustomEvent) => {
    handleSessionRefreshToken(e.detail as SessionRefreshDetail | undefined);
  }) as EventListener);
}
