/**
 * 认证文件与 OAuth 排除模型相关 API
 */

import { apiClient } from './client';
import { getConfigValue, guardConfigConnection, isMissingConfigValue } from './configValue';
import { isRecord } from '@/utils/helpers';
import type { AuthFilesResponse } from '@/types/authFile';
import type { OAuthModelAliasEntry } from '@/types';
import { normalizeOAuthProviderKey } from '@/utils/providerKeys';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import {
  normalizeRecentRequestAuthIndex,
  normalizeRecentRequestBuckets,
  normalizeUsageTotal,
} from '@/utils/recentRequests';
import { parseTimestampMs } from '@/utils/timestamp';
import { normalizeAuthFileCooldowns, normalizeCooldownTimestamp } from './authFileCooldowns';

type AuthFileStatusResponse = { status: string; disabled: boolean };
export type AuthFileLookup = { name: string; authIndex?: string };
type AuthFileEntry = AuthFilesResponse['files'][number];
export type AuthFileFieldsPatch = {
  request_retry?: number | null;
  model_aliases?: Array<{
    name: string;
    alias: string;
    fork?: boolean;
    'display-name'?: string;
    'force-mapping'?: boolean;
  }>;
  request_scoped_errors?: Array<{
    status?: number;
    match?: string[];
    'match-regexr'?: string[];
    action?: string;
  }>;
  prefix?: string;
  proxy_url?: string;
  headers?: Record<string, string>;
  priority?: number;
  weight?: number | null;
  disable_cooling?: boolean;
  'disable-cooling'?: boolean;
  websockets?: boolean;
  using_api?: boolean;
  note?: string;
  excluded_models?: string[];
  'excluded-models'?: string[];
  expired?: string;
};
type AuthFileBatchFailure = { name: string; error: string };
type AuthFileBatchUploadResponse = {
  status?: string;
  uploaded?: number;
  files?: unknown;
  failed?: unknown;
};
type AuthFileBatchDeleteResponse = {
  status?: string;
  deleted?: number;
  files?: unknown;
  failed?: unknown;
};
type AuthFileBatchUploadResult = {
  status: string;
  uploaded: number;
  files: string[];
  failed: AuthFileBatchFailure[];
};
type AuthFileBatchDeleteResult = {
  status: string;
  deleted: number;
  files: string[];
  failed: AuthFileBatchFailure[];
};

const normalizeRequestedAuthFileNames = (names: string[]): string[] => {
  const seen = new Set<string>();
  const normalized: string[] = [];

  names.forEach((name) => {
    const trimmed = String(name ?? '').trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    normalized.push(trimmed);
  });

  return normalized;
};

const normalizeBatchFileNames = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return normalizeRequestedAuthFileNames(value.map((item) => String(item ?? '')));
};

const normalizeBatchFailures = (value: unknown): AuthFileBatchFailure[] => {
  if (!Array.isArray(value)) return [];

  return value.reduce<AuthFileBatchFailure[]>((result, item) => {
    if (!item || typeof item !== 'object') return result;
    const entry = item as Record<string, unknown>;
    const name = String(entry.name ?? '').trim();
    const error =
      typeof entry.error === 'string'
        ? entry.error.trim()
        : typeof entry.message === 'string'
          ? entry.message.trim()
          : '';

    if (!name && !error) return result;
    result.push({ name, error: error || 'Unknown error' });
    return result;
  }, []);
};

const normalizeBatchUploadResponse = (
  payload: AuthFileBatchUploadResponse | undefined,
  requestedNames: string[]
): AuthFileBatchUploadResult => {
  const failed = normalizeBatchFailures(payload?.failed);
  const filesFromPayload = normalizeBatchFileNames(payload?.files);
  // Backend single-file success path returns only {status:"ok"} (auth_files.go:680).
  // Derive count + names from the request when no failures and counts are absent.
  const inferFromRequest = payload?.uploaded === undefined && failed.length === 0;
  return {
    status: payload?.status ?? (failed.length > 0 ? 'partial' : 'ok'),
    uploaded: payload?.uploaded ?? (inferFromRequest ? requestedNames.length : 0),
    files: filesFromPayload.length ? filesFromPayload : inferFromRequest ? [...requestedNames] : [],
    failed,
  };
};

const normalizeBatchDeleteResponse = (
  payload: AuthFileBatchDeleteResponse | undefined,
  requestedNames: string[]
): AuthFileBatchDeleteResult => {
  const failed = normalizeBatchFailures(payload?.failed);
  const filesFromPayload = normalizeBatchFileNames(payload?.files);
  // Backend single-name delete returns only {status:"ok"} (auth_files.go:794).
  const inferFromRequest = payload?.deleted === undefined && failed.length === 0;
  return {
    status: payload?.status ?? (failed.length > 0 ? 'partial' : 'ok'),
    deleted: payload?.deleted ?? (inferFromRequest ? requestedNames.length : 0),
    files: filesFromPayload.length ? filesFromPayload : inferFromRequest ? [...requestedNames] : [],
    failed,
  };
};

const readTextField = (entry: AuthFileEntry, key: string): string => {
  const value = entry[key];
  return typeof value === 'string' ? value.trim() : '';
};

const readDateField = (entry: AuthFileEntry): number => {
  const candidates = [entry['modtime'], entry['updated_at'], entry['last_refresh']];

  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) continue;
      const asNumber = Number(trimmed);
      if (Number.isFinite(asNumber)) {
        return asNumber < 1e12 ? asNumber * 1000 : asNumber;
      }
      const parsed = parseTimestampMs(trimmed);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }

  return 0;
};

const isRuntimeOnlyEntry = (entry: AuthFileEntry): boolean => entry['runtime_only'] === true;

const hasMeaningfulValue = (value: unknown): boolean => {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
};

const countMeaningfulFields = (entry: AuthFileEntry): number =>
  Object.values(entry).reduce<number>(
    (count, value) => count + (hasMeaningfulValue(value) ? 1 : 0),
    0
  );

const authFilePriorityScore = (entry: AuthFileEntry): number => {
  let score = 0;
  if (readTextField(entry, 'source').toLowerCase() === 'file') score += 32;
  if (readTextField(entry, 'path')) score += 16;
  if (!isRuntimeOnlyEntry(entry)) score += 8;
  if (entry.disabled !== true) score += 4;
  if (readDateField(entry) > 0) score += 2;
  return score;
};

const compareAuthFileEntries = (left: AuthFileEntry, right: AuthFileEntry): number => {
  const scoreDiff = authFilePriorityScore(right) - authFilePriorityScore(left);
  if (scoreDiff !== 0) return scoreDiff;

  const dateDiff = readDateField(right) - readDateField(left);
  if (dateDiff !== 0) return dateDiff;

  const fieldDiff = countMeaningfulFields(right) - countMeaningfulFields(left);
  if (fieldDiff !== 0) return fieldDiff;

  return 0;
};

const mergeAuthFileEntries = (entries: AuthFileEntry[]): AuthFileEntry => {
  const [primary, ...rest] = [...entries].sort(compareAuthFileEntries);
  const merged: AuthFileEntry = { ...primary };

  rest.forEach((entry) => {
    Object.entries(entry).forEach(([key, value]) => {
      // Cooldown snapshots are atomic: [] and null are meaningful, not missing fields.
      if (key === 'cooldowns' && Object.prototype.hasOwnProperty.call(merged, key)) return;
      if (!hasMeaningfulValue(merged[key]) && hasMeaningfulValue(value)) {
        merged[key] = value;
      }
    });
  });

  return merged;
};

const INTEGER_STRING_PATTERN = /^[+-]?\d+$/;

const readIntegerField = (value: unknown): number | undefined => {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || !INTEGER_STRING_PATTERN.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const readRuntimeOnlyField = (entry: AuthFileEntry): boolean => {
  const raw = entry['runtime_only'] ?? entry.runtimeOnly;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return raw.trim().toLowerCase() === 'true';
  return false;
};

/**
 * 契约边界归一化：把后端 kebab/snake_case 生字段填充到 AuthFileItem 声明的
 * camelCase 字段上。原始字段全部透传——quota resolvers 仍直接读
 * plan_type / id_token / metadata / attributes 等生字段。
 */
const normalizeAuthFileEntry = (
  entry: AuthFileEntry,
  observedAt: string | undefined,
  receivedAtMs: number
): AuthFileEntry => {
  const declaredStatusMessage =
    typeof entry.statusMessage === 'string' ? entry.statusMessage.trim() : '';
  const statusMessage = readTextField(entry, 'status_message') || declaredStatusMessage;
  const note = readTextField(entry, 'note');
  const email = readTextField(entry, 'email');
  // account / account_type 故意不归一化：api-key 类凭证的 account 就是 API key 本身
  // （sdk/cliproxy/auth/types.go AccountInfo），不能进入展示与搜索路径。
  const projectId = readTextField(entry, 'project_id');
  const modified = readDateField(entry);
  const priority = readIntegerField(entry['priority']);
  const weight = readIntegerField(entry['weight']);

  return {
    ...entry,
    cooldownSnapshot: normalizeAuthFileCooldowns(entry.cooldowns, observedAt, receivedAtMs),
    runtimeOnly: readRuntimeOnlyField(entry),
    authIndex: normalizeRecentRequestAuthIndex(entry['auth_index'] ?? entry.authIndex),
    recentRequests: normalizeRecentRequestBuckets(entry.recent_requests ?? entry.recentRequests),
    successCount: normalizeUsageTotal(entry.success),
    failureCount: normalizeUsageTotal(entry.failed),
    ...(statusMessage ? { statusMessage } : {}),
    ...(modified > 0 ? { modified } : {}),
    priority,
    weight,
    ...(note ? { note } : {}),
    ...(email ? { email } : {}),
    ...(projectId ? { projectId } : {}),
  };
};

export const normalizeAuthFilesResponse = (
  payload: AuthFilesResponse,
  receivedAtMs = Date.now()
): AuthFilesResponse => {
  const observedAt = normalizeCooldownTimestamp(payload?.observed_at);
  const files = Array.isArray(payload?.files) ? payload.files : [];
  const grouped = new Map<string, AuthFileEntry[]>();

  files.forEach((entry) => {
    const name = readTextField(entry, 'name');
    const key = name
      ? getQuotaCacheKey({
          ...entry,
          name,
          authIndex: normalizeRecentRequestAuthIndex(entry['auth_index'] ?? entry.authIndex),
        })
      : JSON.stringify(entry);
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(entry);
      return;
    }
    grouped.set(key, [entry]);
  });

  const normalizedFiles = Array.from(grouped.values()).map((entries) =>
    normalizeAuthFileEntry(mergeAuthFileEntries(entries), observedAt, receivedAtMs)
  );
  normalizedFiles.sort((left, right) => {
    const nameOrder = readTextField(left, 'name').localeCompare(
      readTextField(right, 'name'),
      undefined,
      { sensitivity: 'accent' }
    );
    if (nameOrder !== 0) return nameOrder;
    return String(left.authIndex ?? '').localeCompare(String(right.authIndex ?? ''), undefined, {
      sensitivity: 'accent',
    });
  });

  return {
    ...payload,
    observedAt,
    files: normalizedFiles,
    total: normalizedFiles.length,
  };
};

const normalizeOauthExcludedModels = (payload: unknown): Record<string, string[]> => {
  if (!payload || typeof payload !== 'object') return {};

  const source = payload as Record<string, unknown>;

  const result: Record<string, string[]> = {};

  Object.entries(source as Record<string, unknown>).forEach(([provider, models]) => {
    const key = normalizeOAuthProviderKey(String(provider ?? ''));
    if (!key) return;

    const rawList = Array.isArray(models)
      ? models
      : typeof models === 'string'
        ? models.split(/[\n,]+/)
        : [];

    const normalized = result[key] ?? [];
    const seen = new Set(normalized.map((item) => item.toLowerCase()));
    rawList.forEach((item) => {
      const trimmed = String(item ?? '').trim();
      if (!trimmed) return;
      const modelKey = trimmed.toLowerCase();
      if (seen.has(modelKey)) return;
      seen.add(modelKey);
      normalized.push(trimmed);
    });

    result[key] = normalized;
  });

  return result;
};

const readAliasEntryName = (entry: Record<string, unknown>): string =>
  String(entry.name ?? entry.id ?? entry.model ?? '').trim();

const readAliasEntryForceMapping = (entry: Record<string, unknown>): boolean | undefined => {
  const value = entry['force-mapping'] ?? entry.forceMapping;
  return typeof value === 'boolean' ? value : undefined;
};

const defineOwn = <T>(target: Record<string, T>, key: string, value: T) => {
  // defineProperty keeps keys such as `__proto__` as plain data.
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
};

const hasOwn = (target: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(target, key);

/**
 * Groups alias entries by normalized provider for display. Every entry is kept,
 * including several upstream names that share one alias, and each one remembers
 * its raw config object and provider key spelling so a save can write it back
 * unchanged.
 */
export const normalizeOauthModelAlias = (
  payload: unknown
): Record<string, OAuthModelAliasEntry[]> => {
  if (!payload || typeof payload !== 'object') return {};

  const result: Record<string, OAuthModelAliasEntry[]> = {};

  Object.entries(payload as Record<string, unknown>).forEach(([channel, mappings]) => {
    const key = normalizeOAuthProviderKey(String(channel ?? ''));
    if (!key) return;
    if (!Array.isArray(mappings)) return;

    const normalized = result[key] ?? [];
    mappings.forEach((item) => {
      if (!isRecord(item)) return;
      const entry: OAuthModelAliasEntry = {
        name: readAliasEntryName(item),
        alias: String(item.alias ?? '').trim(),
        raw: { ...item },
        sourceKey: channel,
      };
      if (item.fork === true) entry.fork = true;
      const forceMapping = readAliasEntryForceMapping(item);
      if (forceMapping !== undefined) entry.forceMapping = forceMapping;
      normalized.push(entry);
    });

    if (normalized.length) {
      result[key] = normalized;
    }
  });

  return result;
};

/**
 * Serializes one alias entry. An entry read from the config starts from its raw
 * object, and only fields whose UI value differs from what was read are
 * rewritten. A new entry is built from the edited fields.
 */
export const serializeOauthModelAlias = (entry: OAuthModelAliasEntry): Record<string, unknown> => {
  const raw = entry.raw;
  if (!raw) {
    const payload: Record<string, unknown> = { name: entry.name, alias: entry.alias };
    if (entry.fork) payload.fork = true;
    if (typeof entry.forceMapping === 'boolean') payload['force-mapping'] = entry.forceMapping;
    return payload;
  }

  const payload: Record<string, unknown> = { ...raw };
  if (entry.name !== readAliasEntryName(raw)) payload.name = entry.name;
  if (entry.alias !== String(raw.alias ?? '').trim()) payload.alias = entry.alias;
  if (Boolean(entry.fork) !== (raw.fork === true)) {
    if (entry.fork) payload.fork = true;
    else delete payload.fork;
  }
  if (entry.forceMapping !== readAliasEntryForceMapping(raw)) {
    delete payload.forceMapping;
    if (typeof entry.forceMapping === 'boolean') payload['force-mapping'] = entry.forceMapping;
    else delete payload['force-mapping'];
  }
  return payload;
};

export const serializeOauthModelAliases = (
  aliases: OAuthModelAliasEntry[]
): Array<Record<string, unknown>> => aliases.map(serializeOauthModelAlias);

/**
 * Splits a provider's alias list back into the key spellings its entries were
 * read from. New entries go to the spelling the config already uses for this
 * provider, or to the normalized key when the provider is new.
 */
export const groupOauthModelAliasesBySpelling = (
  provider: string,
  spellings: string[],
  aliases: OAuthModelAliasEntry[]
): Record<string, Array<Record<string, unknown>>> => {
  const key = normalizeOAuthProviderKey(provider);
  const primary = spellings[0] ?? key;
  const groups: Record<string, Array<Record<string, unknown>>> = {};
  aliases.forEach((entry) => {
    const spelling =
      entry.sourceKey && normalizeOAuthProviderKey(entry.sourceKey) === key
        ? entry.sourceKey
        : primary;
    if (!hasOwn(groups, spelling)) defineOwn(groups, spelling, []);
    groups[spelling].push(serializeOauthModelAlias(entry));
  });
  return groups;
};

const excludedModelKey = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toLowerCase();

/**
 * Applies a provider's edited exclusion list to the lists stored under each of
 * its key spellings: kept models stay where they are (verbatim), removed ones are
 * dropped everywhere, and new ones are appended under the first spelling.
 */
export const planOauthExcludedModels = (
  provider: string,
  current: Record<string, unknown>,
  models: string[]
): Record<string, unknown[]> => {
  const key = normalizeOAuthProviderKey(provider);
  const wanted = new Map<string, string>();
  models.forEach((model) => {
    const trimmed = String(model ?? '').trim();
    if (trimmed && !wanted.has(trimmed.toLowerCase())) wanted.set(trimmed.toLowerCase(), trimmed);
  });
  const spellings = Object.keys(current).filter((name) => normalizeOAuthProviderKey(name) === key);
  const next: Record<string, unknown[]> = {};
  const placed = new Set<string>();
  spellings.forEach((spelling) => {
    const list = Array.isArray(current[spelling]) ? (current[spelling] as unknown[]) : [];
    const kept = list.filter((item) => wanted.has(excludedModelKey(item)));
    kept.forEach((item) => placed.add(excludedModelKey(item)));
    if (kept.length) defineOwn(next, spelling, kept);
  });
  const added = Array.from(wanted.entries())
    .filter(([modelKey]) => !placed.has(modelKey))
    .map(([, model]) => model);
  if (added.length) {
    const primary = spellings[0] ?? key;
    defineOwn(next, primary, [...(hasOwn(next, primary) ? next[primary] : []), ...added]);
  }
  return next;
};

const OAUTH_MODEL_ALIAS_ENDPOINT = '/config/oauth/model-alias';
const OAUTH_EXCLUDED_MODELS_ENDPOINT = '/config/oauth/excluded-models';

const oauthMapWrites = new Map<string, Promise<void>>();

// Serialize local read/modify/write operations per map so two edits cannot
// interleave their reads and writes.
function queueOauthMapWrite(path: string, write: () => Promise<void>): Promise<void> {
  const assertConnection = guardConfigConnection();
  const queueKey = `${apiClient.getConnectionRevision()}:${path}`;
  const previous = oauthMapWrites.get(queueKey) ?? Promise.resolve();
  const pending = previous.then(async () => {
    assertConnection();
    await write();
  });
  const settled = pending.then(
    () => undefined,
    () => undefined
  );
  oauthMapWrites.set(queueKey, settled);
  void settled.then(() => {
    if (oauthMapWrites.get(queueKey) === settled) oauthMapWrites.delete(queueKey);
  });
  return pending;
}

/**
 * Rewrites one provider of a v8 OAuth map and leaves every other provider alone.
 * `plan` receives the provider's stored entries keyed by their YAML spelling and
 * returns the next ones. Changed spellings go out in one PATCH of the map (v8
 * replaces lists whole and leaves untouched siblings, comments included, as
 * stored); spellings the plan drops are removed with DELETE, which also prunes
 * the map when it ends up empty.
 */
async function updateOauthProviderMap(
  path: string,
  provider: string,
  plan: (current: Record<string, unknown>) => Record<string, unknown>
) {
  const key = normalizeOAuthProviderKey(provider);
  if (!key) throw new Error('Invalid OAuth provider');
  return queueOauthMapWrite(path, async () => {
    const assertConnection = guardConfigConnection();
    const stored = await getConfigValue<unknown>(path, {});
    assertConnection();
    if (stored != null && !isRecord(stored)) throw new Error('Invalid OAuth configuration map');
    // v8 reads preserve YAML key spelling, and the UI groups by normalized
    // provider, so the plan sees every spelling of this provider.
    const current: Record<string, unknown> = {};
    Object.entries(stored ?? {}).forEach(([name, value]) => {
      if (normalizeOAuthProviderKey(name) === key) defineOwn(current, name, value);
    });
    const next = plan(current);
    const patch: Record<string, unknown> = {};
    Object.entries(next).forEach(([name, value]) => {
      if (hasOwn(current, name) && JSON.stringify(current[name]) === JSON.stringify(value)) return;
      defineOwn(patch, name, value);
    });
    if (Object.keys(patch).length) {
      assertConnection();
      await apiClient.patch(path, patch);
    }
    for (const name of Object.keys(current)) {
      if (hasOwn(next, name)) continue;
      assertConnection();
      try {
        await apiClient.delete(`${path}/${encodeURIComponent(name)}`);
      } catch (error) {
        // Only the handler's own not_found means the key is already gone. A bare
        // 404 (route missing, proxy in between) must not read as a success.
        if (!isMissingConfigValue(error)) throw error;
      }
    }
  });
}

export interface AuthFileRefreshResult {
  id: string;
  success: boolean;
  error?: string;
}

export const normalizeAuthFileRefreshResults = (payload: unknown): AuthFileRefreshResult[] => {
  if (!isRecord(payload) || payload.ok !== true || !Array.isArray(payload.results)) {
    throw new Error('Invalid credential refresh response');
  }
  return payload.results.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== 'string' ||
      !entry.id.trim() ||
      typeof entry.success !== 'boolean'
    ) {
      throw new Error('Invalid credential refresh result');
    }
    // Whitelist result fields: never expose credential metadata or tokens.
    return {
      id: entry.id,
      success: entry.success,
      ...(!entry.success && typeof entry.error === 'string' ? { error: entry.error } : {}),
    };
  });
};

export interface AuthFileCooldownResetResponse {
  status: 'ok';
  auth_index: string;
  models: string[];
}

export const authFilesApi = {
  list: async (lookup?: AuthFileLookup) =>
    normalizeAuthFilesResponse(
      await apiClient.get<AuthFilesResponse>(
        '/credentials',
        lookup ? { params: { name: lookup.name, auth_index: lookup.authIndex } } : undefined
      )
    ),

  setStatus: (name: string, disabled: boolean, authIndex?: string) =>
    apiClient.patch<AuthFileStatusResponse>('/credentials/status', {
      name,
      disabled,
      ...(authIndex ? { auth_index: authIndex } : {}),
    }),

  patchFields: (name: string, fields: AuthFileFieldsPatch) =>
    apiClient.patch('/credentials/fields', { name, ...fields }),

  requestManualRefresh: async (name: string, authIndex?: string): Promise<void> => {
    // The refresh response may include tokens. Never return it to callers.
    await apiClient.post<unknown>('/credentials/refresh', {
      name,
      ...(authIndex ? { auth_index: authIndex } : {}),
    });
  },

  requestAllManualRefresh: async (): Promise<AuthFileRefreshResult[]> => {
    const response = await apiClient.post<unknown>(
      '/credentials/refresh',
      { all: true },
      { timeout: 300_000 }
    );
    return normalizeAuthFileRefreshResults(response);
  },

  resetCooldown: (authIndex: string) =>
    apiClient.post<AuthFileCooldownResetResponse>('/routing/cooldown/reset', {
      auth_index: authIndex,
    }),

  uploadFiles: async (files: File[]): Promise<AuthFileBatchUploadResult> => {
    const requestedNames = files.map((file) => file.name);
    if (requestedNames.length === 0) {
      return { status: 'ok', uploaded: 0, files: [], failed: [] };
    }

    const formData = new FormData();
    files.forEach((file) => {
      formData.append('file', file, file.name);
    });
    const payload = await apiClient.postForm<AuthFileBatchUploadResponse>('/credentials', formData);
    return normalizeBatchUploadResponse(payload, requestedNames);
  },

  deleteFiles: async (names: string[]): Promise<AuthFileBatchDeleteResult> => {
    const requestedNames = normalizeRequestedAuthFileNames(names);
    if (requestedNames.length === 0) {
      return { status: 'ok', deleted: 0, files: [], failed: [] };
    }

    const payload = await apiClient.delete<AuthFileBatchDeleteResponse>('/credentials', {
      data: { names: requestedNames },
    });
    return normalizeBatchDeleteResponse(payload, requestedNames);
  },

  deleteFile: (name: string) => authFilesApi.deleteFiles([name]),

  deleteAll: () => apiClient.delete('/credentials', { params: { all: true } }),

  download: async (name: string): Promise<Blob> => {
    const response = await apiClient.getRaw(
      `/credentials/download?name=${encodeURIComponent(name)}`,
      {
        responseType: 'blob',
      }
    );
    return response.data as Blob;
  },

  downloadText: async (name: string): Promise<string> => {
    const blob = await authFilesApi.download(name);
    return blob.text();
  },

  // OAuth excluded models
  async getOauthExcludedModels(): Promise<Record<string, string[]>> {
    const data = await getConfigValue(OAUTH_EXCLUDED_MODELS_ENDPOINT, {});
    return normalizeOauthExcludedModels(data);
  },

  saveOauthExcludedModels: (provider: string, models: string[]) =>
    updateOauthProviderMap(OAUTH_EXCLUDED_MODELS_ENDPOINT, provider, (current) =>
      planOauthExcludedModels(provider, current, models)
    ),

  deleteOauthExcludedEntry: (provider: string) =>
    updateOauthProviderMap(OAUTH_EXCLUDED_MODELS_ENDPOINT, provider, () => ({})),

  // OAuth model aliases
  async getOauthModelAlias(): Promise<Record<string, OAuthModelAliasEntry[]>> {
    const data = await getConfigValue(OAUTH_MODEL_ALIAS_ENDPOINT, {});
    return normalizeOauthModelAlias(data);
  },

  // Writes the provider's whole alias list. Entries keep their raw fields and key
  // spelling; nothing is deduplicated on this path.
  saveOauthModelAlias: (channel: string, aliases: OAuthModelAliasEntry[]) =>
    updateOauthProviderMap(OAUTH_MODEL_ALIAS_ENDPOINT, channel, (current) =>
      groupOauthModelAliasesBySpelling(channel, Object.keys(current), aliases)
    ),

  deleteOauthModelAlias: (channel: string) =>
    updateOauthProviderMap(OAUTH_MODEL_ALIAS_ENDPOINT, channel, () => ({})),

  // 获取认证凭证支持的模型
  async getModelsForAuthFile(
    name: string
  ): Promise<{ id: string; display_name?: string; type?: string; owned_by?: string }[]> {
    const data = await apiClient.get<Record<string, unknown>>(
      `/credentials/models?name=${encodeURIComponent(name)}`
    );
    const models = data.models ?? data['models'];
    return Array.isArray(models)
      ? (models as { id: string; display_name?: string; type?: string; owned_by?: string }[])
      : [];
  },

  // 获取指定 channel 的模型定义
  async getModelDefinitions(
    channel: string
  ): Promise<{ id: string; display_name?: string; type?: string; owned_by?: string }[]> {
    const normalizedChannel = normalizeOAuthProviderKey(String(channel ?? ''));
    if (!normalizedChannel) return [];
    const data = await apiClient.get<Record<string, unknown>>(
      `/routing/model-definitions/${encodeURIComponent(normalizedChannel)}`
    );
    const models = data.models ?? data['models'];
    return Array.isArray(models)
      ? (models as { id: string; display_name?: string; type?: string; owned_by?: string }[])
      : [];
  },
};
