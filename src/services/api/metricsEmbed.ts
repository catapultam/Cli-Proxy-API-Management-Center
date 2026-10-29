/** Signed Metabase embed URL for the one fixed metrics dashboard. */
import { apiClient } from './client';

export const METRICS_EMBED_PATH = '/observability/usage/metrics-embed';

export type MetricsEmbed =
  { configured: false } | { configured: true; url: string; expiresAt: number };

const malformed = (detail: string): never => {
  throw new Error(`Malformed metrics-embed response: ${detail}`);
};

/** Only an https Metabase static-embed dashboard URL may reach the iframe. */
export const isMetabaseEmbedUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      /^\/(?:.+\/)?embed\/dashboard\/[\w-]+\.[\w-]+\.[\w-]+$/.test(url.pathname)
    );
  } catch {
    return false;
  }
};

export const normalizeMetricsEmbed = (data: unknown): MetricsEmbed => {
  if (data === null || typeof data !== 'object') return malformed('not an object');
  const record = data as Record<string, unknown>;
  if (record.configured === false) return { configured: false };
  if (record.configured !== true) return malformed('configured must be a boolean');
  const { url } = record;
  if (typeof url !== 'string' || !isMetabaseEmbedUrl(url)) return malformed('url');
  const expiresAt =
    typeof record.expires_at === 'string' ? Date.parse(record.expires_at) : Number.NaN;
  if (!Number.isFinite(expiresAt)) return malformed('expires_at');
  return { configured: true, url, expiresAt };
};

export const metricsEmbedApi = {
  async get(): Promise<MetricsEmbed> {
    return normalizeMetricsEmbed(await apiClient.get<unknown>(METRICS_EMBED_PATH));
  },
};

/**
 * Fetch a new URL one minute before expiry: at least 30 s from now, and at most 9 minutes
 * (the 10-minute token lifetime) so a slow client clock cannot outlive the token.
 */
export const metricsEmbedRefreshDelay = (expiresAt: number, now: number): number =>
  Math.min(Math.max(expiresAt - now - 60_000, 30_000), 540_000);
