import { DEFAULT_API_PORT, MANAGEMENT_API_PREFIX } from './constants';

export const normalizeApiBase = (input: string): string => {
  let base = (input || '').trim();
  if (!base) return '';
  base = base.replace(/\/+$/i, '');
  base = base.replace(/\/v8\/management$/i, '');
  if (!/^https?:\/\//i.test(base)) {
    base = `http://${base}`;
  }
  return base;
};

export const computeApiUrl = (base: string): string => {
  const normalized = normalizeApiBase(base);
  if (!normalized) return '';
  return `${normalized}${MANAGEMENT_API_PREFIX}`;
};

/** True when the API base shares the page's origin (regardless of any deployment path prefix). */
export const isSameOriginAsPage = (apiBase: string): boolean => {
  const normalized = normalizeApiBase(apiBase);
  if (!normalized || typeof window === 'undefined') return false;
  try {
    return new URL(normalized).origin === window.location.origin;
  } catch {
    return false;
  }
};

/**
 * The session cookie's `Path` is hardcoded by the backend to `/v8/management` (not prefixed by
 * any deployment path). A request to a non-root apiBase, e.g. `https://host/gateway`, resolves to
 * `https://host/gateway/v8/management/...`, whose path does not start with `/v8/management`, so
 * the browser never sends (or even reliably stores) the cookie there. Cookie mode is therefore
 * only viable when the apiBase is same-origin AND has no path prefix at all.
 */
export const isCookieEligible = (apiBase: string): boolean => {
  const normalized = normalizeApiBase(apiBase);
  if (!normalized || typeof window === 'undefined') return false;
  try {
    const url = new URL(normalized);
    const pathIsRoot = url.pathname === '' || url.pathname === '/';
    return pathIsRoot && url.origin === window.location.origin;
  } catch {
    return false;
  }
};

export const detectApiBaseFromLocation = (): string => {
  try {
    const { protocol, hostname, port } = window.location;
    const normalizedPort = port ? `:${port}` : '';
    return normalizeApiBase(`${protocol}//${hostname}${normalizedPort}`);
  } catch (error) {
    console.warn('Failed to detect api base from location, fallback to default', error);
    return normalizeApiBase(`http://localhost:${DEFAULT_API_PORT}`);
  }
};
