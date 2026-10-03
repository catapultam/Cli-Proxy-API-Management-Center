/**
 * Authenticated account endpoints under `${apiBase}/v8/management/account*`.
 * Reachable with either a management key or a session (cookie/bearer), so these go through
 * the shared `apiClient`, which is already configured for whichever auth mode is active.
 */
import { apiClient } from './client';
import type { AccountPasskey, AccountView, SessionResponse } from '@/types';
import type { PasskeyCeremonyBegin } from './session';

const BASE = '/account';

export interface SaveAccountPayload {
  username: string;
  password: string;
  current_password?: string;
}

export interface SavePasskeySettingsPayload {
  rp_id: string;
  origins: string[];
}

export const accountApi = {
  get: () => apiClient.get<AccountView>(BASE),

  /** First-time setup or a password change. Returns a fresh session for the caller. */
  save: (payload: SaveAccountPayload) => apiClient.put<SessionResponse>(BASE, payload),

  savePasskeySettings: (payload: SavePasskeySettingsPayload) =>
    apiClient.put<AccountView>(`${BASE}/passkey-settings`, payload),

  passkeysBegin: () => apiClient.post<PasskeyCeremonyBegin>(`${BASE}/passkeys/begin`),

  passkeysFinish: (payload: { ceremony_id: string; name: string; credential: unknown }) =>
    apiClient.post<AccountPasskey>(`${BASE}/passkeys/finish`, payload),

  renamePasskey: (id: string, name: string) =>
    apiClient.patch<AccountPasskey>(`${BASE}/passkeys/${encodeURIComponent(id)}`, { name }),

  deletePasskey: (id: string) =>
    apiClient.delete<void>(`${BASE}/passkeys/${encodeURIComponent(id)}`),

  signOutAll: () => apiClient.post<void>(`${BASE}/sign-out-all`),
};
