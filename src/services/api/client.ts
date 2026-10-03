/**
 * Axios API 客户端
 * 替代原项目 src/core/api-client.js
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import type { ApiClientConfig, ApiError } from '@/types';
import {
  BUILD_DATE_HEADER_KEYS,
  CPA_BUILD_DATE_HEADER_KEYS,
  CPA_SESSION_REFRESH_HEADER_KEYS,
  CPA_SUPPORT_PLUGIN_HEADER_KEYS,
  CPA_VERSION_HEADER_KEYS,
  REQUEST_TIMEOUT_MS,
  VERSION_HEADER_KEYS,
} from '@/utils/constants';
import { computeApiUrl } from '@/utils/connection';
import { toApiError } from './apiError';

/** Per-request bookkeeping stamped by the request interceptor, read back by the response/error one. */
interface RequestStampConfig extends AxiosRequestConfig {
  __identityVersion?: number;
  __authTokenAtRequest?: string;
  __apiBaseAtRequest?: string;
}

class ApiClient {
  private instance: AxiosInstance;
  private apiBase: string = '';
  private managementKey: string = '';
  private connectionRevision = 0;
  /** Mirrors the auth store's `identityVersion`, pushed in by `setIdentityVersion`. Never imported
   * from the store directly here to avoid a circular dependency (the store imports this client). */
  private identityVersion = 0;
  /** >0 while an account mutation that can legitimately 401 mid-flight should not trigger a global
   * logout (the caller handles that response itself). See `suspendUnauthorizedHandling()`. */
  private unauthorizedSuspendDepth = 0;

  constructor() {
    this.instance = axios.create({
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
      },
      // The backend's CORS policy is ACAO `*` without Allow-Credentials, so a credentialed
      // cross-origin request fails outright in the browser. Do not set `withCredentials` here:
      // same-origin requests (cookie session mode) send the cookie regardless.
    });

    this.setupInterceptors();
  }

  /**
   * 设置 API 配置
   */
  setConfig(config: ApiClientConfig): void {
    const apiBase = computeApiUrl(config.apiBase);
    if (apiBase !== this.apiBase || config.managementKey !== this.managementKey) {
      this.connectionRevision += 1;
    }
    this.apiBase = apiBase;
    this.managementKey = config.managementKey;

    if (config.timeout) {
      this.instance.defaults.timeout = config.timeout;
    } else {
      this.instance.defaults.timeout = REQUEST_TIMEOUT_MS;
    }
  }

  /** Guards read/modify/write operations across connection changes, including ABA switches. */
  getConnectionRevision(): number {
    return this.connectionRevision;
  }

  /**
   * Swaps only the bearer token, e.g. for a sliding session renewal (`X-CPA-Session-Refresh`).
   * Unlike `setConfig`, this never bumps `connectionRevision`: the request that carried the
   * refresh (and any other in-flight request on the same connection) must not be treated as
   * stale by `getConnectionRevision()`/`guardConfigConnection()` callers.
   */
  setToken(managementKey: string): void {
    this.managementKey = managementKey;
  }

  /** Called by the auth store whenever its `identityVersion` changes (a real login/restore/logout). */
  setIdentityVersion(identityVersion: number): void {
    this.identityVersion = identityVersion;
  }

  /**
   * Suppresses the global `unauthorized` dispatch for the duration of an account mutation
   * (PUT /account, sign-out-all, passkey settings) that legitimately invalidates the caller's own
   * session as a side effect: the component handles that outcome explicitly and a transient 401
   * collision during the window must not also force a surprise global logout. Returns a release
   * function; always call it (e.g. in a `finally`), and it is safe to call more than once.
   */
  suspendUnauthorizedHandling(): () => void {
    this.unauthorizedSuspendDepth += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.unauthorizedSuspendDepth = Math.max(0, this.unauthorizedSuspendDepth - 1);
    };
  }

  private readHeader(headers: Record<string, unknown> | undefined, keys: string[]): string | null {
    if (!headers) return null;

    const normalizeValue = (value: unknown): string | null => {
      if (value === undefined || value === null) return null;
      if (Array.isArray(value)) {
        const first = value.find(
          (entry) => entry !== undefined && entry !== null && String(entry).trim()
        );
        return first !== undefined ? String(first) : null;
      }
      const text = String(value);
      return text ? text : null;
    };

    const headerGetter = (headers as { get?: (name: string) => unknown }).get;
    if (typeof headerGetter === 'function') {
      for (const key of keys) {
        const match = normalizeValue(headerGetter.call(headers, key));
        if (match) return match;
      }
    }

    const entries =
      typeof (headers as { entries?: () => Iterable<[string, unknown]> }).entries === 'function'
        ? Array.from((headers as { entries: () => Iterable<[string, unknown]> }).entries())
        : Object.entries(headers);

    const normalized = Object.fromEntries(
      entries.map(([key, value]) => [String(key).toLowerCase(), value])
    );
    for (const key of keys) {
      const match = normalizeValue(normalized[key.toLowerCase()]);
      if (match) return match;
    }
    return null;
  }

  private readBooleanHeader(
    headers: Record<string, unknown> | undefined,
    keys: string[]
  ): boolean | null {
    const value = this.readHeader(headers, keys);
    if (value === null) return null;

    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return null;
  }

  /**
   * 设置请求/响应拦截器
   */
  private setupInterceptors(): void {
    // 请求拦截器
    this.instance.interceptors.request.use(
      (config) => {
        // 设置 baseURL
        config.baseURL = this.apiBase;

        // 添加认证头
        if (this.managementKey) {
          config.headers.Authorization = `Bearer ${this.managementKey}`;
        }

        // Stamped so the response/error handlers can tell a stale request (made under a since-
        // replaced identity or token) from a current one.
        const stamped = config as RequestStampConfig;
        stamped.__identityVersion = this.identityVersion;
        stamped.__authTokenAtRequest = this.managementKey;
        stamped.__apiBaseAtRequest = this.apiBase;

        return config;
      },
      (error) => Promise.reject(this.handleError(error))
    );

    // 响应拦截器
    this.instance.interceptors.response.use(
      (response) => {
        const headers = response.headers as Record<string, string | undefined>;
        const cpaVersion = this.readHeader(headers, CPA_VERSION_HEADER_KEYS);
        const cpaBuildDate = this.readHeader(headers, CPA_BUILD_DATE_HEADER_KEYS);
        const version = cpaVersion || this.readHeader(headers, VERSION_HEADER_KEYS);
        const buildDate = cpaBuildDate || this.readHeader(headers, BUILD_DATE_HEADER_KEYS);
        const supportsPlugin = this.readBooleanHeader(headers, CPA_SUPPORT_PLUGIN_HEADER_KEYS);
        const sessionRefreshToken = this.readHeader(headers, CPA_SESSION_REFRESH_HEADER_KEYS);

        // Sliding session renewal for bearer-session mode: the backend reissues the token
        // once less than half its lifetime remains. Cookie mode renews via Set-Cookie instead.
        // The request's own stamped token/apiBase ride along so the handler can ignore a late
        // refresh that no longer matches the current identity (see `handleSessionRefreshToken`).
        if (sessionRefreshToken) {
          const requestConfig = response.config as RequestStampConfig;
          window.dispatchEvent(
            new CustomEvent('session-refresh', {
              detail: {
                token: sessionRefreshToken,
                previousToken: requestConfig.__authTokenAtRequest,
                apiBase: requestConfig.__apiBaseAtRequest,
              },
            })
          );
        }

        // 触发版本更新事件（后续通过 store 处理）
        if (version || buildDate) {
          window.dispatchEvent(
            new CustomEvent('server-version-update', {
              detail: { version: version || null, buildDate: buildDate || null },
            })
          );
        }
        if (supportsPlugin !== null) {
          window.dispatchEvent(
            new CustomEvent('server-plugin-support-update', {
              detail: { supportsPlugin },
            })
          );
        }

        return response;
      },
      (error) => Promise.reject(this.handleError(error))
    );
  }

  /**
   * 错误处理
   */
  private handleError(error: unknown): ApiError {
    const apiError = toApiError(error);

    // 401 未授权 - 触发登出事件 (but never for a stale request, and never while suspended)
    if (apiError.status === 401 && this.unauthorizedSuspendDepth === 0) {
      const requestConfig = (error as { config?: RequestStampConfig })?.config;
      const requestIdentityVersion = requestConfig?.__identityVersion;
      const isCurrentIdentity =
        requestIdentityVersion === undefined || requestIdentityVersion === this.identityVersion;
      if (isCurrentIdentity) {
        window.dispatchEvent(new Event('unauthorized'));
      }
    }

    return apiError;
  }

  /**
   * GET 请求
   */
  async get<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.instance.get<T>(url, config);
    return response.data;
  }

  /**
   * POST 请求
   */
  async post<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.instance.post<T>(url, data, config);
    return response.data;
  }

  /**
   * PUT 请求
   */
  async put<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.instance.put<T>(url, data, config);
    return response.data;
  }

  /**
   * PATCH 请求
   */
  async patch<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.instance.patch<T>(url, data, config);
    return response.data;
  }

  /**
   * DELETE 请求
   */
  async delete<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.instance.delete<T>(url, config);
    return response.data;
  }

  /**
   * 获取原始响应（用于下载等场景）
   */
  async getRaw(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse> {
    return this.instance.get(url, config);
  }

  /**
   * 发送 FormData
   */
  async postForm<T = unknown>(
    url: string,
    formData: FormData,
    config?: AxiosRequestConfig
  ): Promise<T> {
    const response = await this.instance.post<T>(url, formData, {
      ...config,
      headers: {
        ...(config?.headers || {}),
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  }
}

// 导出单例
export const apiClient = new ApiClient();
