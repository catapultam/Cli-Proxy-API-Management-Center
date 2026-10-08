/**
 * Quota page auto-refresh interval preference: persisted in localStorage (unlike
 * uiState.ts's sessionStorage) so the choice survives across browser sessions.
 */

import {
  QUOTA_AUTO_REFRESH_DEFAULT_MS,
  QUOTA_AUTO_REFRESH_OPTIONS,
  type QuotaAutoRefreshMs,
} from './constants';

const QUOTA_AUTO_REFRESH_KEY = 'quotaPage.autoRefreshMs';

const QUOTA_AUTO_REFRESH_SET = new Set<number>(QUOTA_AUTO_REFRESH_OPTIONS);

export const isQuotaAutoRefreshMs = (value: unknown): value is QuotaAutoRefreshMs =>
  typeof value === 'number' && Number.isFinite(value) && QUOTA_AUTO_REFRESH_SET.has(value);

export const readQuotaAutoRefreshMs = (): QuotaAutoRefreshMs => {
  if (typeof window === 'undefined') return QUOTA_AUTO_REFRESH_DEFAULT_MS;
  try {
    const raw = window.localStorage.getItem(QUOTA_AUTO_REFRESH_KEY);
    if (raw === null) return QUOTA_AUTO_REFRESH_DEFAULT_MS;
    const parsed = JSON.parse(raw);
    return isQuotaAutoRefreshMs(parsed) ? parsed : QUOTA_AUTO_REFRESH_DEFAULT_MS;
  } catch {
    return QUOTA_AUTO_REFRESH_DEFAULT_MS;
  }
};

export const writeQuotaAutoRefreshMs = (value: QuotaAutoRefreshMs) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(QUOTA_AUTO_REFRESH_KEY, JSON.stringify(value));
  } catch {
    // ignore storage failures
  }
};
