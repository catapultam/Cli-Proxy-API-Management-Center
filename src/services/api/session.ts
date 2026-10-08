/**
 * Public session endpoints under `${apiBase}/v8/management/session/*`.
 *
 * These routes are reachable without a management key (status/login/passkey/logout), so they
 * intentionally bypass the shared `apiClient` singleton: the panel may probe or log in against
 * an API base that is not (yet) the one `apiClient` is configured for, and a failed login
 * attempt (401/409/429) must never trigger the global `unauthorized` logout event that
 * `apiClient` fires for authenticated requests.
 */
import axios from 'axios';
import { computeApiUrl } from '@/utils/connection';
import { REQUEST_TIMEOUT_MS } from '@/utils/constants';
import { toApiError } from './apiError';
import type { SessionResponse, SessionStatus } from '@/types';

const SESSION_PATH = '/session';

interface SessionRequestOptions {
  data?: unknown;
  bearerToken?: string;
}

async function sessionRequest<T>(
  method: 'get' | 'post',
  apiBase: string,
  path: string,
  options: SessionRequestOptions = {}
): Promise<T> {
  try {
    // The backend's CORS policy is ACAO `*` without Allow-Credentials: never set
    // `withCredentials` here. A same-origin request sends the `cpa_mgmt_session` cookie anyway.
    const response = await axios.request<T>({
      method,
      url: `${computeApiUrl(apiBase)}${SESSION_PATH}${path}`,
      data: options.data,
      timeout: REQUEST_TIMEOUT_MS,
      headers: options.bearerToken ? { Authorization: `Bearer ${options.bearerToken}` } : undefined,
    });
    return response.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export interface PasskeyCeremonyBegin {
  ceremony_id: string;
  options: unknown;
}

export const sessionApi = {
  /** `bearerToken` lets a restored bearer-session check its own stored token. */
  getStatus: (apiBase: string, bearerToken?: string) =>
    sessionRequest<SessionStatus>('get', apiBase, '/status', { bearerToken }),

  login: (
    apiBase: string,
    credentials: { username: string; password: string; remember?: boolean }
  ) => sessionRequest<SessionResponse>('post', apiBase, '/login', { data: credentials }),

  passkeyBegin: (apiBase: string) =>
    sessionRequest<PasskeyCeremonyBegin>('post', apiBase, '/passkey/begin'),

  passkeyFinish: (
    apiBase: string,
    payload: { ceremony_id: string; credential: unknown; remember?: boolean }
  ) => sessionRequest<SessionResponse>('post', apiBase, '/passkey/finish', { data: payload }),

  logout: (apiBase: string) => sessionRequest<void>('post', apiBase, '/logout'),
};
