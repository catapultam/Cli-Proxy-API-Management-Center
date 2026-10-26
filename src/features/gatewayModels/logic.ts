import { serializeGatewayModels, type GatewayModelEntry } from '@/services/api/gatewayModels';
import { generateId } from '@/utils/helpers';

export const CLIENT_ID_PREFIX = 'claude-gw-';
export const DEFAULT_BEHAVES_AS = 'claude-fable-5-1';
export const MAX_ROWS = 200;
/** Bytes (UTF-8). */
export const MAX_TEXT_LENGTH = 256;
export const MIN_COMPACT_WINDOW = 100000;
export const MAX_COMPACT_WINDOW = 1000000;

/** Canonical Claude IDs offered as suggestions; any Claude ID can still be typed. */
export const BEHAVES_AS_OPTIONS = [
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
] as const;

/** A row as edited: the compact window stays text so a half-typed number is not lost. */
export interface GatewayModelDraft extends Omit<GatewayModelEntry, 'autoCompactWindow'> {
  key: string;
  autoCompactWindow: string;
}

export const buildEmptyDraft = (): GatewayModelDraft => ({
  key: generateId(),
  id: '',
  label: '',
  behavesAs: DEFAULT_BEHAVES_AS,
  autoCompactWindow: '',
  effortLevel: '',
  hideFromDiscovery: true,
  extra: {},
});

export const toDrafts = (entries: readonly GatewayModelEntry[]): GatewayModelDraft[] =>
  entries.map((entry) => ({
    ...entry,
    key: generateId(),
    autoCompactWindow: entry.autoCompactWindow === null ? '' : String(entry.autoCompactWindow),
  }));

/** Blank or non-integer text reads as null; validateDrafts reports the invalid case. */
export const parseCompactWindow = (text: string): number | null => {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
};

export const toEntries = (drafts: readonly GatewayModelDraft[]): GatewayModelEntry[] =>
  drafts.map(({ key: _key, autoCompactWindow, ...rest }) => ({
    ...rest,
    autoCompactWindow: parseCompactWindow(autoCompactWindow),
  }));

/** What the backend would receive; equal signatures mean the same save. */
export const getDraftsSignature = (drafts: readonly GatewayModelDraft[]): string =>
  JSON.stringify(serializeGatewayModels(toEntries(drafts)));

/** The readable ID clients see in the /model picker. */
export const getClientModelId = (id: string): string => {
  const trimmed = id.trim();
  return trimmed ? `${CLIENT_ID_PREFIX}${trimmed}` : '';
};

export type GatewayField = 'id' | 'label' | 'behavesAs' | 'autoCompactWindow';

export interface GatewayFieldError {
  /** Key under gateway_models.* */
  code: string;
  params?: Record<string, string | number>;
  /** Required-field errors wait until the user tries to save. */
  required?: boolean;
}

export type GatewayDraftErrors = Partial<Record<GatewayField, GatewayFieldError>>;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const BEHAVES_AS_PATTERN = /^claude-[A-Za-z0-9-]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

const encoder = new TextEncoder();
/** The backend caps text at 256 bytes, not characters. */
const exceedsLimit = (text: string): boolean => encoder.encode(text).length > MAX_TEXT_LENGTH;

export function validateDrafts(drafts: readonly GatewayModelDraft[]): GatewayDraftErrors[] {
  const firstIndex = new Map<string, number>();
  drafts.forEach((draft, index) => {
    const lowered = draft.id.trim().toLowerCase();
    if (lowered && !firstIndex.has(lowered)) firstIndex.set(lowered, index);
  });

  return drafts.map((draft, index) => {
    const errors: GatewayDraftErrors = {};
    const id = draft.id.trim();
    if (!id) {
      errors.id = { code: 'error_id_required', required: true };
    } else if (exceedsLimit(id)) {
      errors.id = { code: 'error_too_long', params: { max: MAX_TEXT_LENGTH } };
    } else if (!ID_PATTERN.test(id)) {
      errors.id = { code: 'error_id_format' };
    } else if (id.toLowerCase().startsWith('claude-')) {
      errors.id = { code: 'error_id_claude_prefix' };
    } else if (firstIndex.get(id.toLowerCase()) !== index) {
      errors.id = { code: 'error_id_duplicate' };
    }

    if (exceedsLimit(draft.label.trim())) {
      errors.label = { code: 'error_too_long', params: { max: MAX_TEXT_LENGTH } };
    } else if (CONTROL_CHARS.test(draft.label.trim())) {
      errors.label = { code: 'error_label_control' };
    }

    const behavesAs = draft.behavesAs.trim();
    if (!behavesAs) {
      errors.behavesAs = { code: 'error_behaves_required', required: true };
    } else if (exceedsLimit(behavesAs)) {
      errors.behavesAs = { code: 'error_too_long', params: { max: MAX_TEXT_LENGTH } };
    } else if (!BEHAVES_AS_PATTERN.test(behavesAs)) {
      errors.behavesAs = { code: 'error_behaves_invalid' };
    }

    const compact = draft.autoCompactWindow.trim();
    if (compact) {
      const value = parseCompactWindow(compact);
      if (value === null || value < MIN_COMPACT_WINDOW || value > MAX_COMPACT_WINDOW) {
        errors.autoCompactWindow = {
          code: 'error_compact_range',
          params: { min: MIN_COMPACT_WINDOW, max: MAX_COMPACT_WINDOW },
        };
      }
    }
    return errors;
  });
}

export const countErrors = (errors: readonly GatewayDraftErrors[]): number =>
  errors.reduce((total, row) => total + Object.keys(row).length, 0);
