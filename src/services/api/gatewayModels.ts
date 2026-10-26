/** Per-model Claude Code gateway settings: upstream.claude.gateway-models. */
import { apiClient } from './client';
import { getConfigValue } from './configValue';

export const GATEWAY_MODELS_PATH = '/config/upstream/claude/gateway-models';

export const GATEWAY_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
export type GatewayEffortLevel = (typeof GATEWAY_EFFORT_LEVELS)[number];

export interface GatewayModelEntry {
  id: string;
  label: string;
  behavesAs: string;
  /** Tokens; null means automatic. */
  autoCompactWindow: number | null;
  /** Empty means inherited from the client. */
  effortLevel: GatewayEffortLevel | '';
  hideFromDiscovery: boolean;
  /** Fields this page does not edit, kept so a save does not drop them. */
  extra: Record<string, unknown>;
}

const KNOWN_KEYS = new Set([
  'id',
  'label',
  'behaves-as',
  'auto-compact-window',
  'effort-level',
  'hide-from-discovery',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const malformed = (detail: string): never => {
  throw new Error(`Malformed gateway-models response: ${detail}`);
};

const optionalText = (value: unknown, field: string): string => {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : malformed(`${field} must be a string`);
};

/** The backend stores automatic as 0 or absent; both read as blank. */
const optionalWindow = (value: unknown): number | null => {
  if (value === undefined || value === null || value === 0) return null;
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : malformed('auto-compact-window must be a number');
};

const optionalEffort = (value: unknown): GatewayEffortLevel | '' => {
  if (value === undefined || value === null || value === '') return '';
  return typeof value === 'string' && (GATEWAY_EFFORT_LEVELS as readonly string[]).includes(value)
    ? (value as GatewayEffortLevel)
    : malformed('effort-level is not a known level');
};

/** Hide omitted means true, matching the backend default. */
const optionalHide = (value: unknown): boolean => {
  if (value === undefined || value === null) return true;
  return typeof value === 'boolean' ? value : malformed('hide-from-discovery must be a boolean');
};

/**
 * Throws on malformed data: rendering a partial list as editable could let a save erase rows.
 * A missing config key never reaches here; getConfigValue maps it to [].
 */
export function normalizeGatewayModels(data: unknown): GatewayModelEntry[] {
  // The backend reports an empty list as null.
  if (data === null) return [];
  if (!Array.isArray(data)) return malformed('expected an array');
  return data.map((item, index) => {
    if (!isRecord(item)) return malformed(`row ${index + 1} is not an object`);
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item)) {
      if (!KNOWN_KEYS.has(key)) extra[key] = value;
    }
    return {
      id: optionalText(item.id, 'id'),
      label: optionalText(item.label, 'label'),
      behavesAs: optionalText(item['behaves-as'], 'behaves-as'),
      autoCompactWindow: optionalWindow(item['auto-compact-window']),
      effortLevel: optionalEffort(item['effort-level']),
      hideFromDiscovery: optionalHide(item['hide-from-discovery']),
      extra,
    };
  });
}

/** Blank optional fields are omitted so the backend applies its own defaults. */
export function serializeGatewayModels(entries: readonly GatewayModelEntry[]): unknown[] {
  return entries.map((entry) => {
    const row: Record<string, unknown> = { ...entry.extra, id: entry.id.trim() };
    const label = entry.label.trim();
    if (label) row.label = label;
    row['behaves-as'] = entry.behavesAs.trim();
    if (entry.autoCompactWindow !== null) row['auto-compact-window'] = entry.autoCompactWindow;
    if (entry.effortLevel) row['effort-level'] = entry.effortLevel;
    row['hide-from-discovery'] = entry.hideFromDiscovery;
    return row;
  });
}

export const gatewayModelsApi = {
  /** A config with no gateway-models key yet reads as an empty list. */
  async list(): Promise<GatewayModelEntry[]> {
    return normalizeGatewayModels(await getConfigValue<unknown>(GATEWAY_MODELS_PATH, []));
  },

  /** Replaces only this list; the rest of the config is untouched. */
  replace: (entries: readonly GatewayModelEntry[]) =>
    apiClient.put(GATEWAY_MODELS_PATH, serializeGatewayModels(entries)),
};
