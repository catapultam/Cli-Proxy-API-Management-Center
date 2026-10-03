import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { apiClient } from '@/services/api/client';
import { authFilesApi, serializeOauthModelAliases } from '@/services/api/authFiles';
import {
  addAliasLink,
  hasNewAliasConflict,
  removeAliasFromMappings,
  removeAliasLink,
  renameAliasInMappings,
  setAliasLinkFork,
} from '@/features/authFiles/oauthAliasEdits';
import type { OAuthModelAliasEntry } from '@/types';

const ENDPOINT = '/config/oauth/model-alias';

// What GET /v8/management/config/oauth/model-alias returns for a hand-written
// config: display names, a two-upstream pool on one alias (differing in case),
// mixed-case and underscore provider keys, a legacy provider spelling, fork and
// force-mapping.
const STORED = {
  claude: [
    {
      name: 'claude-sonnet-4-5-20990101',
      alias: 'sonnet',
      'display-name': 'Sonnet (pinned)',
      'force-mapping': true,
    },
    { name: 'claude-sonnet-4-5', alias: 'SONNET', 'display-name': 'Sonnet (rolling)' },
    { name: 'claude-opus-4-1', alias: 'opus', fork: true },
  ],
  Codex: [
    { name: 'gpt-5', alias: 'gpt-5-codex', fork: true, 'display-name': 'GPT-5 (Codex)' },
    { name: 'gpt-5-mini', alias: 'mini' },
  ],
  gemini_cli: [
    { name: 'gemini-2.5-pro', alias: 'g-pro', 'display-name': 'Gemini Pro' },
    { name: 'gemini-2.5-flash', alias: 'g-pro' },
  ],
  grok: [{ name: 'grok-4', alias: 'grok', 'force-mapping': false }],
};

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));

// In-memory v8 handler for the alias map: PATCH merges provider keys and replaces
// their lists whole, DELETE removes one provider key.
const serve = () => {
  const state = { stored: structuredClone(STORED) as Record<string, unknown> };
  const writes: Array<{ method: string; path: string; body?: unknown }> = [];
  spies.push(
    spyOn(apiClient, 'get').mockImplementation((async () =>
      structuredClone(state.stored)) as never),
    spyOn(apiClient, 'put').mockImplementation((async () => {
      throw new Error('whole-map PUT is not expected');
    }) as never),
    spyOn(apiClient, 'patch').mockImplementation((async (path: string, body: unknown) => {
      writes.push({ method: 'PATCH', path, body: structuredClone(body) });
      state.stored = { ...state.stored, ...structuredClone(body as Record<string, unknown>) };
      return {};
    }) as never),
    spyOn(apiClient, 'delete').mockImplementation((async (path: string) => {
      writes.push({ method: 'DELETE', path });
      const key = decodeURIComponent(path.split('/').pop() ?? '');
      const next = { ...state.stored };
      delete next[key];
      state.stored = next;
      return {};
    }) as never)
  );
  return { state, writes };
};

const expected = (edit: (config: Record<string, Array<Record<string, unknown>>>) => void) => {
  const config = structuredClone(STORED) as Record<string, Array<Record<string, unknown>>>;
  edit(config);
  return config;
};

describe('OAuth model alias round trip', () => {
  test('reads every entry, grouped by provider, without deduplicating the pool', async () => {
    serve();
    const view = await authFilesApi.getOauthModelAlias();
    expect(Object.keys(view).sort()).toEqual(['claude', 'codex', 'gemini-cli', 'xai']);
    expect(view.claude.map((entry) => entry.name)).toEqual([
      'claude-sonnet-4-5-20990101',
      'claude-sonnet-4-5',
      'claude-opus-4-1',
    ]);
    expect(view['gemini-cli']).toHaveLength(2);
    expect(view.codex[0].sourceKey).toBe('Codex');
    expect(view.xai[0].sourceKey).toBe('grok');
    // Serializing what was read reproduces each stored list exactly.
    expect(serializeOauthModelAliases(view.claude)).toEqual(STORED.claude);
    expect(serializeOauthModelAliases(view.codex)).toEqual(STORED.Codex);
    expect(serializeOauthModelAliases(view['gemini-cli'])).toEqual(STORED.gemini_cli);
    expect(serializeOauthModelAliases(view.xai)).toEqual(STORED.grok);
  });

  test('saving every provider unedited sends no writes', async () => {
    const { state, writes } = serve();
    const view = await authFilesApi.getOauthModelAlias();
    for (const [provider, mappings] of Object.entries(view)) {
      await authFilesApi.saveOauthModelAlias(provider, mappings);
    }
    expect(writes).toEqual([]);
    expect(state.stored).toEqual(STORED);
  });

  test('renaming an alias rewrites only that alias, across the whole pool', async () => {
    const { state, writes } = serve();
    const view = await authFilesApi.getOauthModelAlias();
    for (const [provider, mappings] of Object.entries(view)) {
      const next = renameAliasInMappings(mappings, 'sonnet', 'sonnet-latest');
      if (next) await authFilesApi.saveOauthModelAlias(provider, next);
    }
    expect(writes.map(({ method, path }) => `${method} ${path}`)).toEqual([`PATCH ${ENDPOINT}`]);
    expect(Object.keys(writes[0].body as object)).toEqual(['claude']);
    expect(state.stored).toEqual(
      expected((config) => {
        config.claude[0].alias = 'sonnet-latest';
        config.claude[1].alias = 'sonnet-latest';
      })
    );
  });

  test('toggling fork changes only that entry and keeps the mixed-case key', async () => {
    const { state, writes } = serve();
    const view = await authFilesApi.getOauthModelAlias();
    const next = setAliasLinkFork(view.codex, 'gpt-5', 'gpt-5-codex', false)!;
    await authFilesApi.saveOauthModelAlias('codex', next);
    expect(writes).toEqual([
      {
        method: 'PATCH',
        path: ENDPOINT,
        body: {
          Codex: [
            { name: 'gpt-5', alias: 'gpt-5-codex', 'display-name': 'GPT-5 (Codex)' },
            { name: 'gpt-5-mini', alias: 'mini' },
          ],
        },
      },
    ]);
    expect(state.stored).toEqual(expected((config) => delete config.Codex[0].fork));

    const forkOn = setAliasLinkFork(view.codex, 'gpt-5-mini', 'mini', true)!;
    await authFilesApi.saveOauthModelAlias('codex', forkOn);
    expect(state.stored).toEqual(
      expected((config) => {
        config.Codex[1].fork = true;
      })
    );
  });

  test('unlinking one pool member keeps the other and its display name', async () => {
    const { state, writes } = serve();
    const view = await authFilesApi.getOauthModelAlias();
    const next = removeAliasLink(view['gemini-cli'], 'gemini-2.5-flash', 'g-pro')!;
    await authFilesApi.saveOauthModelAlias('gemini-cli', next);
    expect(writes).toEqual([
      {
        method: 'PATCH',
        path: ENDPOINT,
        body: {
          gemini_cli: [{ name: 'gemini-2.5-pro', alias: 'g-pro', 'display-name': 'Gemini Pro' }],
        },
      },
    ]);
    expect(state.stored).toEqual(expected((config) => config.gemini_cli.splice(1, 1)));
  });

  test('deleting an alias removes only its entries; an emptied provider is deleted', async () => {
    const { state, writes } = serve();
    const view = await authFilesApi.getOauthModelAlias();
    for (const [provider, mappings] of Object.entries(view)) {
      const next = removeAliasFromMappings(mappings, 'grok');
      if (!next) continue;
      if (next.length) await authFilesApi.saveOauthModelAlias(provider, next);
      else await authFilesApi.deleteOauthModelAlias(provider);
    }
    expect(writes).toEqual([{ method: 'DELETE', path: `${ENDPOINT}/grok` }]);
    expect(state.stored).toEqual(expected((config) => delete config.grok));

    const pool = removeAliasFromMappings(view.claude, 'Sonnet')!;
    await authFilesApi.saveOauthModelAlias('claude', pool);
    expect(state.stored).toEqual(
      expected((config) => {
        delete config.grok;
        config.claude.splice(0, 2);
      })
    );
  });

  test('a new link is appended under the provider spelling already in use', async () => {
    const { state, writes } = serve();
    const view = await authFilesApi.getOauthModelAlias();
    const next = addAliasLink(view.xai, 'grok-4-fast', 'grok-fast')!;
    await authFilesApi.saveOauthModelAlias('xai', next);
    expect(writes).toEqual([
      {
        method: 'PATCH',
        path: ENDPOINT,
        body: {
          grok: [
            { name: 'grok-4', alias: 'grok', 'force-mapping': false },
            { name: 'grok-4-fast', alias: 'grok-fast', fork: true },
          ],
        },
      },
    ]);
    expect(state.stored).toEqual(
      expected((config) => {
        config.grok.push({ name: 'grok-4-fast', alias: 'grok-fast', fork: true });
      })
    );
  });

  test('the edit page changes only the edited row', async () => {
    const { state } = serve();
    const view = await authFilesApi.getOauthModelAlias();
    // Rows as the edit page builds them (spread plus a row id), then one edit.
    const rows = view.claude.map((entry, index) => ({ ...entry, id: `row-${index}` }));
    rows[2] = { ...rows[2], alias: 'opus-latest' };
    const toSave: OAuthModelAliasEntry[] = rows.map(({ id: _id, ...entry }) => entry);
    expect(hasNewAliasConflict(toSave)).toBe(false);
    await authFilesApi.saveOauthModelAlias('claude', toSave);
    expect(state.stored).toEqual(
      expected((config) => {
        config.claude[2].alias = 'opus-latest';
      })
    );
  });

  test('stored pools are not flagged as conflicts; a new collision is', async () => {
    serve();
    const view = await authFilesApi.getOauthModelAlias();
    expect(hasNewAliasConflict(view.claude)).toBe(false);
    expect(hasNewAliasConflict(view['gemini-cli'])).toBe(false);
    expect(hasNewAliasConflict([...view.claude, { name: 'claude-haiku', alias: 'opus' }])).toBe(
      true
    );
    const renamed = view.claude.map((entry) =>
      entry.alias === 'opus' ? { ...entry, alias: 'Sonnet' } : entry
    );
    expect(hasNewAliasConflict(renamed)).toBe(true);
  });
});
