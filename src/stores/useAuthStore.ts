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
import {
  detectApiBaseFromLocation,
  isSameOriginAsPage,
  normalizeApiBase,
} from '@/utils/connection';

interface AuthStoreState extends AuthState {
  connectionStatus: ConnectionStatus;
  /**
   * Last known `session/status` response for the current `apiBase`. Populated by
   * `restoreSession`/`refreshSessionStatus`, consumed by `LoginPage` to decide which form to
   * show. `null` means the endpoint is unavailable (old backend) or has not been checked yet.
   */
  sessionStatus: SessionStatus | null;

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
  ) => void;
  refreshSessionStatus: (apiBaseOverride?: string) => Promise<SessionStatus | null>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<boolean>;
  restoreSession: () => Promise<boolean>;
  updateServerVersion: (version: string | null, buildDate?: string | null) => void;
  updateServerPluginSupport: (supportsPlugin: boolean) => void;
}

let restoreSessionPromise: Promise<boolean> | null = null;

/** Fetches session status without ever throwing; `null` means unavailable (e.g. old backend). */
async function fetchSessionStatusSafely(
  apiBase: string,
  bearerToken?: string
): Promise<SessionStatus | null> {
  if (!apiBase) return null;
  try {
    return await sessionApi.getStatus(apiBase, bearerToken);
  } catch {
    return null;
  }
}

export const useAuthStore = create<AuthStoreState>()(
  persist(
    (set, get) => ({
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
      sessionExpiresAt: null,
      loginMethod: '',
      sessionStatus: null,

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
          const status = await fetchSessionStatusSafely(resolvedBase, bearerToken);
          set({ apiBase: resolvedBase, sessionStatus: status });

          if (status?.authenticated) {
            const transport: SessionTransport = isSameOriginAsPage(resolvedBase)
              ? 'cookie'
              : 'bearer';
            const tokenForClient = transport === 'bearer' ? bearerToken || '' : '';
            apiClient.setConfig({ apiBase: resolvedBase, managementKey: tokenForClient });
            set({
              isAuthenticated: true,
              apiBase: resolvedBase,
              managementKey: tokenForClient,
              authMode: 'session',
              sessionTransport: transport,
              loginMethod: status.method,
              connectionStatus: 'connected',
            });
            return true;
          }

          if (previousAuthMode === 'session') {
            // The remembered session is gone (expired, revoked, or the backend no longer
            // supports sessions). `managementKey` here is a session token, not a real
            // management key, so it must never be retried against the legacy key flow below.
            apiClient.setConfig({ apiBase: resolvedBase, managementKey: '' });
            set({
              isAuthenticated: false,
              managementKey: '',
              authMode: 'key',
              sessionTransport: 'bearer',
              sessionExpiresAt: null,
              loginMethod: '',
              connectionStatus: 'disconnected',
            });
            return false;
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
            }
          }

          return false;
        })();

        return restoreSessionPromise;
      },

      // 刷新当前 apiBase 的 session/status（供登录页在用户修改 Advanced 连接地址后重新探测）
      refreshSessionStatus: async (apiBaseOverride) => {
        const base = normalizeApiBase(apiBaseOverride ?? get().apiBase);
        const status = await fetchSessionStatusSafely(base);
        set({ sessionStatus: status });
        return status;
      },

      // 登录（管理密钥模式，今天的行为保持不变）
      login: async (credentials) => {
        const apiBase = normalizeApiBase(credentials.apiBase);
        const managementKey = credentials.managementKey.trim();
        const rememberPassword = credentials.rememberPassword ?? get().rememberPassword ?? false;

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
            sessionExpiresAt: null,
            loginMethod: 'key',
            connectionStatus: 'connected',
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
          get().applySessionLogin(normalizedBase, response, 'password');
        } catch (error) {
          set({ connectionStatus: 'error' });
          throw error;
        }
      },

      // 由密码或 passkey 登录成功后，统一落地会话状态（选择 cookie / bearer 传输方式）
      applySessionLogin: (apiBase, response, method) => {
        const normalizedBase = normalizeApiBase(apiBase);
        const transport: SessionTransport = isSameOriginAsPage(normalizedBase)
          ? 'cookie'
          : 'bearer';
        const tokenForClient = transport === 'bearer' ? response.token : '';

        useConfigStore.getState().clearCache();
        useModelsStore.getState().clearCache();
        useQuotaStore.getState().clearQuotaCache();

        apiClient.setConfig({ apiBase: normalizedBase, managementKey: tokenForClient });
        set({
          isAuthenticated: true,
          apiBase: normalizedBase,
          managementKey: tokenForClient,
          rememberPassword: true,
          authMode: 'session',
          sessionTransport: transport,
          sessionExpiresAt: response.expires_at,
          loginMethod: method,
          connectionStatus: 'connected',
        });
        localStorage.setItem('isLoggedIn', 'true');
      },

      // 登出
      logout: async () => {
        restoreSessionPromise = null;
        const { authMode, apiBase } = get();

        if (authMode === 'session' && apiBase) {
          try {
            await sessionApi.logout(apiBase);
          } catch {
            // Ignore logout errors (e.g. already expired); local state is always cleared below.
          }
        }

        apiClient.setConfig({ apiBase: '', managementKey: '' });
        useConfigStore.getState().clearCache();
        useModelsStore.getState().clearCache();
        useQuotaStore.getState().clearQuotaCache();
        set({
          isAuthenticated: false,
          apiBase: '',
          managementKey: '',
          serverVersion: null,
          serverBuildDate: null,
          supportsPlugin: false,
          connectionStatus: 'disconnected',
          authMode: 'key',
          sessionTransport: 'bearer',
          sessionExpiresAt: null,
          loginMethod: '',
          sessionStatus: null,
        });
        localStorage.removeItem('isLoggedIn');
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
    }),
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
        ...(state.rememberPassword ? { managementKey: state.managementKey } : {}),
        rememberPassword: state.rememberPassword,
        serverVersion: state.serverVersion,
        serverBuildDate: state.serverBuildDate,
        authMode: state.authMode,
        sessionTransport: state.sessionTransport,
      }),
    }
  )
);

/**
 * Sliding bearer-session renewal: `apiClient` dispatches a `session-refresh` window event when a
 * response carries `X-CPA-Session-Refresh`. Cookie-mode sessions renew via `Set-Cookie` instead
 * and never emit it. Exported (rather than inlined in the listener below) so it has a single,
 * directly testable entry point independent of whether `window` exists at module-load time.
 */
export function handleSessionRefreshToken(token: string | null | undefined): void {
  if (!token) return;
  const state = useAuthStore.getState();
  if (state.authMode !== 'session' || state.sessionTransport !== 'bearer') return;
  apiClient.setConfig({ apiBase: state.apiBase, managementKey: token });
  useAuthStore.setState({ managementKey: token });
}

// 监听全局未授权事件
if (typeof window !== 'undefined') {
  window.addEventListener('unauthorized', () => {
    useAuthStore.getState().logout();
  });

  window.addEventListener('server-version-update', ((e: CustomEvent) => {
    const detail = e.detail || {};
    useAuthStore.getState().updateServerVersion(detail.version || null, detail.buildDate || null);
  }) as EventListener);

  window.addEventListener('server-plugin-support-update', ((e: CustomEvent) => {
    useAuthStore.getState().updateServerPluginSupport(e.detail?.supportsPlugin === true);
  }) as EventListener);

  window.addEventListener('session-refresh', ((e: CustomEvent) => {
    handleSessionRefreshToken(e.detail?.token);
  }) as EventListener);
}
