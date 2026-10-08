/**
 * 认证相关类型定义
 * 基于原项目 src/modules/login.js 和 src/core/connection.js
 */

// 登录凭据
export interface LoginCredentials {
  apiBase: string;
  managementKey: string;
  rememberPassword?: boolean;
}

// 认证模式：'key' 是今天的管理密钥流程，'session' 是用户名/密码或 passkey 会话
export type AuthMode = 'key' | 'session';

// 会话传输方式：同源使用 Cookie，跨源使用 Bearer token
export type SessionTransport = 'cookie' | 'bearer';

export type SessionLoginMethod = 'password' | 'passkey' | 'key' | '';

// 认证状态
export interface AuthState {
  isAuthenticated: boolean;
  apiBase: string;
  managementKey: string;
  rememberPassword: boolean;
  serverVersion: string | null;
  serverBuildDate: string | null;
  supportsPlugin: boolean;
  authMode: AuthMode;
  sessionTransport: SessionTransport;
  loginMethod: SessionLoginMethod;
  /**
   * The "Remember me" choice behind the CURRENT session-mode login (password/passkey), as opposed
   * to `rememberPassword`, which only ever applies to the management-key flow. When false, the
   * session is a short-lived browser session: the bearer token is kept in sessionStorage instead
   * of being persisted to localStorage. Irrelevant in key mode.
   */
  sessionRemember: boolean;
}

// 连接状态
export type ConnectionStatus = 'connected' | 'disconnected' | 'connecting' | 'error';

// GET /v8/management/session/status
export interface SessionStatus {
  account: boolean;
  authenticated: boolean;
  method: SessionLoginMethod;
  passkeys_available: boolean;
  /** The effective allow-list (defaults to `["https://" + passkey_rp_id]` when unset server-side). */
  passkey_origins: string[];
  passkey_rp_id: string;
}

// Session response returned by login/passkey-finish/account PUT
export interface SessionResponse {
  token: string;
  expires_at: string;
  /**
   * The remember choice the backend actually applied. Never trust the requested flag alone: an
   * older proxy that doesn't understand `remember` at all silently issues (and never echoes) a
   * persistent 30-day session regardless of what was asked, so every call site must compute the
   * EFFECTIVE remember as `response.remember ?? true` and use that -- not the value it sent in
   * the request -- to decide `sessionRemember`, cookie/localStorage behavior, etc.
   */
  remember?: boolean;
}

export interface AccountPasskey {
  id: string;
  name: string;
  created_at: string;
}

// GET /v8/management/account
export interface AccountView {
  configured: boolean;
  username: string;
  passkeys: AccountPasskey[];
  passkey_rp_id: string;
  passkey_origins: string[];
}
