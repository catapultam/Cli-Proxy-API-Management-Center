import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import { apiClient } from '@/services/api/client';
import {
  GATEWAY_MODELS_PATH,
  gatewayModelsApi,
  normalizeGatewayModels,
  serializeGatewayModels,
} from '@/services/api/gatewayModels';
import {
  MAX_TEXT_LENGTH,
  buildEmptyDraft,
  countErrors,
  getClientModelId,
  getDraftsSignature,
  toDrafts,
  toEntries,
  validateDrafts,
  type GatewayModelDraft,
} from '@/features/gatewayModels/logic';
import { GatewayModelRow } from '@/features/gatewayModels/components/GatewayModelRow';
import en from '../src/i18n/locales/en.json';
import zhCN from '../src/i18n/locales/zh-CN.json';
import zhTW from '../src/i18n/locales/zh-TW.json';
import ru from '../src/i18n/locales/ru.json';

const i18n = createInstance();
await i18n.init({ lng: 'en', resources: { en: { translation: en } } });

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));

const STORED = [
  {
    id: 'gpt-6.1-sol',
    label: 'GPT 6.1 Sol',
    'behaves-as': 'claude-fable-5-1',
    'auto-compact-window': 400000,
    'effort-level': 'high',
    'hide-from-discovery': false,
    'future-field': { keep: true },
  },
  { id: 'qwen-local', 'behaves-as': 'claude-haiku-4-5' },
];

const draft = (patch: Partial<GatewayModelDraft> = {}): GatewayModelDraft => ({
  ...buildEmptyDraft(),
  id: 'model-a',
  ...patch,
});

describe('gateway models API layer', () => {
  test('reads rows, defaults hide to true when omitted and keeps unknown fields', () => {
    const rows = normalizeGatewayModels(STORED);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 'gpt-6.1-sol',
      label: 'GPT 6.1 Sol',
      behavesAs: 'claude-fable-5-1',
      autoCompactWindow: 400000,
      effortLevel: 'high',
      hideFromDiscovery: false,
      extra: { 'future-field': { keep: true } },
    });
    expect(rows[1]).toMatchObject({
      id: 'qwen-local',
      label: '',
      autoCompactWindow: null,
      effortLevel: '',
      hideFromDiscovery: true,
    });
  });

  test('throws on malformed data instead of returning a partial editable list', () => {
    expect(() => normalizeGatewayModels(undefined)).toThrow('Malformed');
    expect(() => normalizeGatewayModels({ id: 'x' })).toThrow('expected an array');
    expect(() => normalizeGatewayModels('nope')).toThrow('Malformed');
    expect(() => normalizeGatewayModels([{ id: 'ok' }, 'x'])).toThrow('row 2');
    expect(() => normalizeGatewayModels([[]])).toThrow('row 1');
    expect(() => normalizeGatewayModels([{ id: 5 }])).toThrow('id must be a string');
    expect(() => normalizeGatewayModels([{ id: 'a', 'effort-level': 'max' }])).toThrow('effort');
    expect(() => normalizeGatewayModels([{ id: 'a', 'auto-compact-window': '4e5' }])).toThrow(
      'auto-compact-window'
    );
    expect(() => normalizeGatewayModels([{ id: 'a', 'hide-from-discovery': 'no' }])).toThrow(
      'hide-from-discovery'
    );
    expect(normalizeGatewayModels([])).toEqual([]);
  });

  test('reads the backend empty list (null) and automatic window (0) as blank', () => {
    expect(normalizeGatewayModels(null)).toEqual([]);
    const [row] = normalizeGatewayModels([
      { id: 'a', 'behaves-as': 'claude-fable-5-1', 'auto-compact-window': 0 },
    ]);
    expect(row.autoCompactWindow).toBeNull();
    expect(toDrafts([row])[0].autoCompactWindow).toBe('');
    expect(serializeGatewayModels([row])[0]).not.toHaveProperty('auto-compact-window');
  });

  test('GET rejects a malformed response instead of showing an empty list', async () => {
    spies.push(spyOn(apiClient, 'get').mockImplementation((async () => ({ id: 'x' })) as never));
    await expect(gatewayModelsApi.list()).rejects.toThrow('Malformed');
  });

  test('serializes kebab-case keys, omits blanks and always states hide explicitly', () => {
    const rows = normalizeGatewayModels(STORED);
    expect(serializeGatewayModels(rows)).toEqual([
      STORED[0],
      { id: 'qwen-local', 'behaves-as': 'claude-haiku-4-5', 'hide-from-discovery': true },
    ]);
    const edited = [{ ...rows[0], id: ' spaced ', label: '  ', autoCompactWindow: null }];
    expect(serializeGatewayModels(edited)[0]).toEqual({
      'future-field': { keep: true },
      id: 'spaced',
      'behaves-as': 'claude-fable-5-1',
      'effort-level': 'high',
      'hide-from-discovery': false,
    });
  });

  test('GET treats a missing key (404 not_found) as an empty list', async () => {
    spies.push(
      spyOn(apiClient, 'get').mockImplementation((async () => {
        throw Object.assign(new Error('not found'), { status: 404, apiCode: 'not_found' });
      }) as never)
    );
    expect(await gatewayModelsApi.list()).toEqual([]);
  });

  test('GET surfaces other failures instead of showing an empty editable list', async () => {
    for (const error of [
      { status: 404, apiCode: 'route_missing' },
      { status: 500, apiCode: 'internal' },
    ]) {
      const spy = spyOn(apiClient, 'get').mockImplementation((async () => {
        throw Object.assign(new Error('boom'), error);
      }) as never);
      await expect(gatewayModelsApi.list()).rejects.toThrow('boom');
      spy.mockRestore();
    }
  });

  test('PUT replaces only the gateway-models list at its own path', async () => {
    const put = spyOn(apiClient, 'put').mockImplementation((async () => ({})) as never);
    spies.push(put);
    await gatewayModelsApi.replace(normalizeGatewayModels(STORED));
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0]).toBe(GATEWAY_MODELS_PATH);
    expect(GATEWAY_MODELS_PATH).toBe('/config/upstream/claude/gateway-models');
    expect(put.mock.calls[0][1]).toEqual([
      STORED[0],
      { id: 'qwen-local', 'behaves-as': 'claude-haiku-4-5', 'hide-from-discovery': true },
    ]);
  });
});

describe('gateway models drafts', () => {
  test('round-trips through drafts without changing the saved shape', () => {
    const entries = normalizeGatewayModels(STORED);
    const drafts = toDrafts(entries);
    expect(drafts[0].autoCompactWindow).toBe('400000');
    expect(drafts[1].autoCompactWindow).toBe('');
    expect(toEntries(drafts)).toEqual(entries);
    expect(new Set(drafts.map((d) => d.key)).size).toBe(2);
  });

  test('dirty signature ignores row keys and whitespace but sees real edits', () => {
    const base = toDrafts(normalizeGatewayModels(STORED));
    const baseline = getDraftsSignature(base);
    expect(getDraftsSignature(toDrafts(normalizeGatewayModels(STORED)))).toBe(baseline);
    expect(getDraftsSignature([{ ...base[0], id: ' gpt-6.1-sol ' }, base[1]])).toBe(baseline);
    expect(getDraftsSignature([{ ...base[0], hideFromDiscovery: true }, base[1]])).not.toBe(
      baseline
    );
    expect(getDraftsSignature([base[1], base[0]])).not.toBe(baseline);
  });

  test('new rows default to hidden discovery and the default behaves-as', () => {
    const row = buildEmptyDraft();
    expect(row).toMatchObject({ behavesAs: 'claude-fable-5-1', hideFromDiscovery: true });
    expect(buildEmptyDraft().key).not.toBe(row.key);
  });

  test('shows the readable client ID for the original provider ID', () => {
    expect(getClientModelId('gpt-6.1-sol')).toBe('claude-gw-gpt-6.1-sol');
    expect(getClientModelId('  qwen  ')).toBe('claude-gw-qwen');
    expect(getClientModelId('   ')).toBe('');
  });
});

describe('gateway models validation', () => {
  test('accepts a complete valid list', () => {
    const errors = validateDrafts(toDrafts(normalizeGatewayModels(STORED)));
    expect(countErrors(errors)).toBe(0);
  });

  test('flags required fields as quiet-until-save', () => {
    const [errors] = validateDrafts([draft({ id: ' ', behavesAs: '' })]);
    expect(errors.id).toMatchObject({ code: 'error_id_required', required: true });
    expect(errors.behavesAs).toMatchObject({ code: 'error_behaves_required', required: true });
  });

  test.each([
    ['claude-opus-4-1', 'error_id_claude_prefix'],
    ['Claude-thing', 'error_id_claude_prefix'],
    ['has space', 'error_id_format'],
    ['tab\tid', 'error_id_format'],
    ['bell\u0007', 'error_id_format'],
    ['wild*', 'error_id_format'],
    ['paren(1)', 'error_id_format'],
    ['_leading', 'error_id_format'],
    ['-leading', 'error_id_format'],
    ['.leading', 'error_id_format'],
    ['café', 'error_id_format'],
    ['x'.repeat(MAX_TEXT_LENGTH + 1), 'error_too_long'],
  ])('rejects id %j with %s', (id, code) => {
    const [errors] = validateDrafts([draft({ id })]);
    expect(errors.id?.code).toBe(code);
    expect(errors.id?.required).toBeUndefined();
  });

  test('accepts provider ids with dots, colons, slashes and hyphens', () => {
    for (const id of ['gpt-6.1-sol', 'org/model:7b-q4_K', '9lives', 'A.B_c']) {
      expect(countErrors(validateDrafts([draft({ id })]))).toBe(0);
    }
  });

  test('label control characters are rejected, ordinary text is not', () => {
    expect(validateDrafts([draft({ label: 'a\u0007b' })])[0].label?.code).toBe(
      'error_label_control'
    );
    expect(validateDrafts([draft({ label: 'a\nb' })])[0].label?.code).toBe('error_label_control');
    expect(validateDrafts([draft({ label: 'GPT 6.1 · Sol' })])[0].label).toBeUndefined();
  });

  test('accepts an id at the length cap and dotted provider ids', () => {
    expect(countErrors(validateDrafts([draft({ id: 'x'.repeat(MAX_TEXT_LENGTH) })]))).toBe(0);
    expect(countErrors(validateDrafts([draft({ id: 'gpt-6.1-sol' })]))).toBe(0);
  });

  test('duplicates are case-insensitive and reported on the later row only', () => {
    const errors = validateDrafts([
      draft({ id: 'Model-A' }),
      draft({ id: 'other' }),
      draft({ id: 'model-a ' }),
    ]);
    expect(errors[0].id).toBeUndefined();
    expect(errors[1].id).toBeUndefined();
    expect(errors[2].id?.code).toBe('error_id_duplicate');
  });

  test('behaves-as must be a Claude id without whitespace', () => {
    expect(validateDrafts([draft({ behavesAs: 'gpt-5' })])[0].behavesAs?.code).toBe(
      'error_behaves_invalid'
    );
    for (const bad of ['claude fable', 'Claude-opus-5-5', 'claude-', 'claude-opus.5', 'claude_x']) {
      expect(validateDrafts([draft({ behavesAs: bad })])[0].behavesAs?.code).toBe(
        'error_behaves_invalid'
      );
    }
    expect(validateDrafts([draft({ behavesAs: 'claude-fable-5-1' })])[0].behavesAs).toBeUndefined();
  });

  test.each([
    ['', true],
    ['100000', true],
    ['1000000', true],
    ['99999', false],
    ['1000001', false],
    ['abc', false],
    ['400000.5', false],
    ['-200000', false],
    ['4e5', false],
  ])('compact window %j valid=%p', (value, valid) => {
    const [errors] = validateDrafts([draft({ autoCompactWindow: value })]);
    expect(errors.autoCompactWindow === undefined).toBe(valid);
  });

  test('text caps count UTF-8 bytes, not characters', () => {
    const twoByte = String.fromCharCode(233);
    const atCap = twoByte.repeat(MAX_TEXT_LENGTH / 2);
    expect(validateDrafts([draft({ label: atCap })])[0].label).toBeUndefined();
    expect(validateDrafts([draft({ label: atCap + 'a' })])[0].label?.code).toBe('error_too_long');
  });

  test('C1 control characters are rejected in labels', () => {
    const c1 = String.fromCharCode(0x85);
    expect(validateDrafts([draft({ label: 'a' + c1 + 'b' })])[0].label?.code).toBe(
      'error_label_control'
    );
  });

  test('label length is capped', () => {
    expect(validateDrafts([draft({ label: 'l'.repeat(MAX_TEXT_LENGTH + 1) })])[0].label?.code).toBe(
      'error_too_long'
    );
  });
});

describe('gateway model row', () => {
  const noop = () => {};
  const render = (props: Partial<Parameters<typeof GatewayModelRow>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(GatewayModelRow, {
          draft: draft({ id: 'gpt-6.1-sol', label: 'Sol', autoCompactWindow: '400000' }),
          index: 0,
          errors: {},
          disabled: false,
          onChange: noop,
          onRemove: noop,
          ...props,
        })
      )
    );

  test('renders every setting, the generated client ID and a named remove action', () => {
    const markup = render();
    expect(markup).toContain('claude-gw-gpt-6.1-sol');
    expect(markup).toContain('value="gpt-6.1-sol"');
    expect(markup).toContain('value="Sol"');
    expect(markup).toContain('value="claude-fable-5-1"');
    expect(markup).toContain('value="400000"');
    expect(markup).toContain('Hide from discovery');
    expect(markup).toContain('aria-label="Remove gateway model 1"');
    expect(markup).toContain('aria-label="Gateway model 1"');
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('checked=""');
  });

  test('shows a prompt instead of a client ID until the model ID is typed', () => {
    const markup = render({ draft: draft({ id: '' }) });
    expect(markup).toContain('Enter a model ID to see its client ID');
    expect(markup).not.toContain('claude-gw-<');
  });

  test('renders inline errors with interpolated values and marks inputs invalid', () => {
    const markup = render({
      errors: {
        id: { code: 'error_id_duplicate' },
        autoCompactWindow: {
          code: 'error_compact_range',
          params: { min: 100000, max: 1000000 },
        },
      },
    });
    expect(markup).toContain('Another row already uses this ID');
    expect(markup).toContain('Enter a whole number from 100000 to 1000000, or leave blank');
    expect(markup).toContain('aria-invalid="true"');
  });

  test('disables every control while saving', () => {
    const markup = render({ disabled: true });
    expect(markup.match(/<input[^>]*disabled/g)?.length).toBeGreaterThanOrEqual(5);
    expect(markup).toContain('disabled=""');
  });
});

describe('gateway models locales', () => {
  const locales = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ru } as Record<
    string,
    Record<string, unknown>
  >;
  const keysOf = (locale: Record<string, unknown>) =>
    Object.keys((locale.gateway_models ?? {}) as Record<string, unknown>).sort();

  test('every locale defines the same keys, plus the nav entries', () => {
    const reference = keysOf(en);
    expect(reference.length).toBeGreaterThan(30);
    for (const [name, locale] of Object.entries(locales)) {
      expect(keysOf(locale)).toEqual(reference);
      expect((locale.nav as Record<string, string>).gateway_models).toBeTruthy();
      expect((locale.nav_meta as Record<string, string>).gateway_models).toBeTruthy();
      expect(name).toBeTruthy();
    }
  });

  test('every validation code resolves to a message in every locale', () => {
    const errors = validateDrafts([
      draft({ id: '', behavesAs: '' }),
      draft({ id: 'claude-x' }),
      draft({ id: 'a b' }),
      draft({ id: 'ctl', label: 'a	b' }),
      draft({
        id: 'z'.repeat(300),
        label: 'l'.repeat(300),
        behavesAs: 'x',
        autoCompactWindow: '1',
      }),
      draft({ id: 'dup' }),
      draft({ id: 'DUP' }),
    ]);
    const codes = new Set(
      errors.flatMap((row) => Object.values(row).map((error) => error?.code as string))
    );
    expect([...codes].sort()).toEqual([
      'error_behaves_invalid',
      'error_behaves_required',
      'error_compact_range',
      'error_id_claude_prefix',
      'error_id_duplicate',
      'error_id_format',
      'error_id_required',
      'error_label_control',
      'error_too_long',
    ]);
    for (const locale of Object.values(locales)) {
      const block = locale.gateway_models as Record<string, string>;
      for (const code of codes) expect(block[code]).toBeTruthy();
    }
  });

  test('new copy contains no em or en dashes', () => {
    for (const locale of Object.values(locales)) {
      expect(JSON.stringify(locale.gateway_models)).not.toMatch(/[–—]/);
    }
  });
});
