import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { apiClient } from '@/services/api/client';
import { apiKeysApi } from '@/services/api/apiKeys';
import { authFilesApi } from '@/services/api/authFiles';
import { oauthApi } from '@/services/api/oauth';
import { pluginsApi, pluginStoreApi } from '@/services/api/plugins';
import { configApi } from '@/services/api/config';
import { configFileApi } from '@/services/api/configFile';
import { logsApi } from '@/services/api/logs';
import { versionApi } from '@/services/api/version';
import { vertexApi } from '@/services/api/vertex';
import { apiKeyUsageApi } from '@/services/api/apiKeyUsage';

const spies: Array<{ mockRestore(): void }> = [];
const mock = (
  method: 'get' | 'put' | 'patch' | 'post' | 'delete' | 'getRaw' | 'postForm',
  value: unknown = {}
) => {
  const spy = spyOn(apiClient, method).mockResolvedValue(value as never);
  spies.push(spy);
  return spy;
};
afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));

describe('v8 management API contracts', () => {
  test('client keys read direct lists and replace whole lists for update/delete', async () => {
    const get = mock('get', ['first', 'second']);
    const put = mock('put');
    expect(await apiKeysApi.list()).toEqual(['first', 'second']);
    expect(get).toHaveBeenCalledWith('/config/access/api-keys');
    await apiKeysApi.update(1, 'updated');
    expect(put).toHaveBeenLastCalledWith('/config/access/api-keys', ['first', 'updated']);
    get.mockResolvedValue(['first', 'second']);
    await apiKeysApi.delete(0);
    expect(put).toHaveBeenLastCalledWith('/config/access/api-keys', ['second']);
    await expect(apiKeysApi.update(-1, 'bad')).rejects.toBeInstanceOf(RangeError);
    expect(put).toHaveBeenCalledTimes(2);
  });

  test('read/modify/write operations abort after a connection change, even when switched back', async () => {
    const first = { apiBase: 'https://first.invalid', managementKey: 'fixture' };
    apiClient.setConfig(first);
    const get = mock('get');
    const put = mock('put');
    const patch = mock('patch');
    const del = mock('delete');
    try {
      for (const operation of [
        () => apiKeysApi.update(0, 'new'),
        () => apiKeysApi.delete(0),
        () => pluginsApi.patchConfig('example', { custom: 'new' }),
        () => authFilesApi.saveOauthExcludedModels('codex', ['blocked']),
        () => authFilesApi.deleteOauthModelAlias('codex'),
      ]) {
        get.mockImplementation(async () => {
          apiClient.setConfig({
            apiBase: 'https://second.invalid',
            managementKey: 'other-fixture',
          });
          apiClient.setConfig(first);
          return ['old-fixture'];
        });
        await expect(operation()).rejects.toMatchObject({ name: 'AbortError' });
      }
      expect(put).not.toHaveBeenCalled();
      expect(patch).not.toHaveBeenCalled();
      expect(del).not.toHaveBeenCalled();
    } finally {
      apiClient.setConfig({ apiBase: '', managementKey: '' });
    }
  });

  // Mirrors the v8 handler for one OAuth map: GET returns the stored map, PATCH
  // merges provider keys (lists replaced whole), DELETE removes one key or 404s.
  const fakeOauthMap = (initial: Record<string, unknown>) => {
    const state = { stored: structuredClone(initial) };
    const get = mock('get').mockImplementation(async () => structuredClone(state.stored));
    const patch = mock('patch').mockImplementation(async (_path, value) => {
      state.stored = { ...state.stored, ...structuredClone(value as Record<string, unknown>) };
      return {};
    });
    const del = mock('delete').mockImplementation(async (path) => {
      const key = decodeURIComponent(String(path).split('/').pop() ?? '');
      if (!Object.prototype.hasOwnProperty.call(state.stored, key)) {
        throw { status: 404, apiCode: 'not_found' };
      }
      const next = { ...state.stored };
      delete next[key];
      state.stored = next;
      return {};
    });
    return { state, get, patch, del };
  };

  test('OAuth configuration reads direct maps and writes one provider at a time', async () => {
    const get = mock('get', {
      codex: [{ name: 'source', alias: 'alias', 'force-mapping': false }],
    });
    const put = mock('put');
    const patch = mock('patch');
    const del = mock('delete');
    expect(await authFilesApi.getOauthModelAlias()).toEqual({
      codex: [
        {
          name: 'source',
          alias: 'alias',
          forceMapping: false,
          raw: { name: 'source', alias: 'alias', 'force-mapping': false },
          sourceKey: 'codex',
        },
      ],
    });
    expect(get).toHaveBeenLastCalledWith('/config/oauth/model-alias');
    await authFilesApi.saveOauthModelAlias('codex', [
      { name: 'source', alias: 'alias', forceMapping: true },
    ]);
    expect(patch).toHaveBeenLastCalledWith('/config/oauth/model-alias', {
      codex: [{ name: 'source', alias: 'alias', 'force-mapping': true }],
    });
    get.mockResolvedValue({ codex: ['blocked'] });
    expect(await authFilesApi.getOauthExcludedModels()).toEqual({ codex: ['blocked'] });
    expect(get).toHaveBeenLastCalledWith('/config/oauth/excluded-models');
    await authFilesApi.saveOauthExcludedModels('codex', ['blocked', 'new']);
    expect(patch).toHaveBeenLastCalledWith('/config/oauth/excluded-models', {
      codex: ['blocked', 'new'],
    });
    await authFilesApi.deleteOauthModelAlias('codex');
    expect(del).toHaveBeenLastCalledWith('/config/oauth/model-alias/codex');
    await authFilesApi.deleteOauthExcludedEntry('codex');
    expect(del).toHaveBeenLastCalledWith('/config/oauth/excluded-models/codex');
    // An unchanged list is not rewritten, and nothing ever replaces the whole map.
    const patches = patch.mock.calls.length;
    await authFilesApi.saveOauthExcludedModels('codex', ['blocked']);
    expect(patch.mock.calls.length).toBe(patches);
    expect(put).not.toHaveBeenCalled();
  });

  test('OAuth writes keep stored key spellings and never send other providers', async () => {
    const other = [{ name: 'other', alias: 'other', 'display-name': 'Other' }];
    const get = mock('get', {
      ' Codex ': [{ name: 'old', alias: 'old' }],
      codex: [{ name: 'duplicate', alias: 'duplicate' }],
      claude: other,
    });
    const patch = mock('patch');
    const del = mock('delete');
    await authFilesApi.saveOauthModelAlias('codex', [{ name: 'new', alias: 'new' }]);
    expect(patch).toHaveBeenLastCalledWith('/config/oauth/model-alias', {
      ' Codex ': [{ name: 'new', alias: 'new' }],
    });
    expect(del).toHaveBeenLastCalledWith('/config/oauth/model-alias/codex');
    expect(del).toHaveBeenCalledTimes(1);
    await authFilesApi.deleteOauthModelAlias('codex');
    expect(del.mock.calls.slice(1).map(([path]) => path)).toEqual([
      '/config/oauth/model-alias/%20Codex%20',
      '/config/oauth/model-alias/codex',
    ]);
    get.mockResolvedValue({ ' Codex ': ['a'], CODEX: ['b'], claude: ['keep'] });
    await authFilesApi.saveOauthExcludedModels('codex', ['b', 'new']);
    expect(patch).toHaveBeenLastCalledWith('/config/oauth/excluded-models', {
      ' Codex ': ['new'],
    });
    expect(del).toHaveBeenCalledTimes(3);
  });

  test('concurrent OAuth alias renames and deletes preserve every provider update', async () => {
    const server = fakeOauthMap({
      codex: [{ name: 'codex-model', alias: 'shared' }],
      claude: [{ name: 'claude-model', alias: 'shared' }],
      gemini: [{ name: 'untouched', alias: 'keep', future: true }],
    });

    await Promise.all([
      authFilesApi.saveOauthModelAlias('codex', [{ name: 'codex-model', alias: 'renamed' }]),
      authFilesApi.saveOauthModelAlias('claude', [{ name: 'claude-model', alias: 'renamed' }]),
    ]);
    expect(server.state.stored).toEqual({
      codex: [{ name: 'codex-model', alias: 'renamed' }],
      claude: [{ name: 'claude-model', alias: 'renamed' }],
      gemini: [{ name: 'untouched', alias: 'keep', future: true }],
    });

    await Promise.all([
      authFilesApi.deleteOauthModelAlias('codex'),
      authFilesApi.deleteOauthModelAlias('claude'),
    ]);
    expect(server.state.stored).toEqual({
      gemini: [{ name: 'untouched', alias: 'keep', future: true }],
    });
  });

  test('concurrent excluded-model writes preserve changes and recover after a failed write', async () => {
    const server = fakeOauthMap({ codex: ['old'], claude: ['old'] });
    await Promise.all([
      authFilesApi.saveOauthExcludedModels('codex', ['new']),
      authFilesApi.saveOauthExcludedModels('claude', ['new']),
    ]);
    expect(server.state.stored).toEqual({ codex: ['new'], claude: ['new'] });

    server.del.mockRejectedValueOnce(new Error('write failed'));
    const results = await Promise.allSettled([
      authFilesApi.deleteOauthExcludedEntry('codex'),
      authFilesApi.deleteOauthExcludedEntry('claude'),
    ]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
    expect(server.state.stored).toEqual({ codex: ['new'] });
    await authFilesApi.deleteOauthExcludedEntry('codex');
    expect(server.state.stored).toEqual({});
    // Deleting a provider that is already gone sends nothing.
    const deletes = server.del.mock.calls.length;
    await authFilesApi.deleteOauthExcludedEntry('codex');
    expect(server.del.mock.calls.length).toBe(deletes);
  });

  test('queued OAuth writes abort before reading after an ABA connection switch', async () => {
    const first = { apiBase: 'https://first.invalid', managementKey: 'fixture' };
    apiClient.setConfig(first);
    let releaseRead!: (value: unknown) => void;
    const blockedRead = new Promise<unknown>((resolve) => {
      releaseRead = resolve;
    });
    let notifyRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      notifyRead = resolve;
    });
    const get = mock('get', { codex: [{ name: 'a', alias: 'b' }] }).mockImplementationOnce(
      async () => {
        notifyRead();
        return blockedRead;
      }
    );
    const put = mock('put');
    const patch = mock('patch');
    const del = mock('delete');
    try {
      const results = Promise.allSettled([
        authFilesApi.deleteOauthModelAlias('codex'),
        authFilesApi.deleteOauthModelAlias('claude'),
      ]);
      await readStarted;
      apiClient.setConfig({ apiBase: 'https://second.invalid', managementKey: 'other' });
      apiClient.setConfig(first);
      releaseRead({ codex: [{ name: 'a', alias: 'b' }], claude: [{ name: 'c', alias: 'd' }] });
      for (const result of await results) {
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') expect(result.reason.name).toBe('AbortError');
      }
      expect(get).toHaveBeenCalledTimes(1);
      expect(put).not.toHaveBeenCalled();
      expect(patch).not.toHaveBeenCalled();
      expect(del).not.toHaveBeenCalled();
      await authFilesApi.deleteOauthModelAlias('codex');
      expect(del).toHaveBeenCalledTimes(1);
      expect(del).toHaveBeenLastCalledWith('/config/oauth/model-alias/codex');
    } finally {
      releaseRead({});
      apiClient.setConfig({ apiBase: '', managementKey: '' });
    }
  });

  test('only missing persisted config fields default; auth/network/route failures propagate', async () => {
    const get = mock('get');
    const readers = [
      apiKeysApi.list,
      authFilesApi.getOauthExcludedModels,
      authFilesApi.getOauthModelAlias,
      () => pluginsApi.getConfig('example'),
    ];
    for (const reader of readers) {
      get.mockRejectedValue({ status: 404, apiCode: 'not_found' });
      expect(await reader()).toEqual(reader === apiKeysApi.list ? [] : {});
      for (const error of [{ status: 401 }, { status: 404 }, new Error('network')]) {
        get.mockRejectedValue(error);
        await expect(reader()).rejects.toBe(error);
      }
    }
    const put = mock('put');
    const patch = mock('patch');
    const del = mock('delete');
    // A missing map has nothing to delete: no write is sent.
    get.mockRejectedValue({ status: 404, apiCode: 'not_found' });
    await authFilesApi.deleteOauthModelAlias('codex');
    get.mockRejectedValue({ status: 405 });
    await expect(authFilesApi.deleteOauthModelAlias('codex')).rejects.toEqual({ status: 405 });
    expect(put).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  test('OAuth maps UI anthropic to claude and plugins use the shared login route', async () => {
    const get = mock('get');
    const post = mock('post');
    await oauthApi.startAuth('anthropic');
    expect(get).toHaveBeenLastCalledWith('/oauth/auth-url', {
      params: { provider: 'claude', is_webui: true },
    });
    await oauthApi.startAuth('example-plugin');
    expect(get).toHaveBeenLastCalledWith('/oauth/auth-url', {
      params: { provider: 'example-plugin' },
    });
    await oauthApi.submitCallback('anthropic', 'https://example.test/callback?code=test');
    expect(post).toHaveBeenLastCalledWith(
      '/oauth/callback',
      { provider: 'claude', redirect_url: 'https://example.test/callback?code=test' },
      undefined
    );
  });

  test('plugin enabled is an instance config scalar, preserving sibling config', async () => {
    const get = mock('get', { enabled: false, custom: 'value' });
    const put = mock('put');
    const post = mock('post');
    expect(await pluginsApi.getConfig('example')).toEqual({ enabled: false, custom: 'value' });
    expect(get).toHaveBeenLastCalledWith('/config/plugins/configs/example');
    await pluginsApi.patchConfig('example', { custom: 'new' });
    expect(put).toHaveBeenLastCalledWith('/config/plugins/configs/example', {
      enabled: false,
      custom: 'new',
    });
    await pluginsApi.updateEnabled('example', false);
    expect(put).toHaveBeenLastCalledWith('/config/plugins/configs/example/enabled', false);
    await pluginStoreApi.list();
    expect(get).toHaveBeenLastCalledWith('/plugins/store');
    await pluginStoreApi.install('example', { sourceId: 'official', version: '1.2.3' });
    expect(post).toHaveBeenLastCalledWith(
      '/plugins/store/example/install?source=official&version=1.2.3',
      { version: '1.2.3' }
    );
  });

  test('plugin form clears delete fields and object edits replace instead of deep-merging', async () => {
    mock('get', {
      enabled: true,
      untouched: { future: 'preserved' },
      cleared: 'remove-me',
      edited: { keep: 1, obsolete: 2 },
    });
    const put = mock('put');
    await pluginsApi.patchConfig('example', { cleared: null, edited: { keep: 3 } });
    expect(put).toHaveBeenCalledWith('/config/plugins/configs/example', {
      enabled: true,
      untouched: { future: 'preserved' },
      edited: { keep: 3 },
    });
  });

  test('operational routes and YAML retain business payloads, config booleans are unwrapped', async () => {
    const get = mock('get');
    const put = mock('put');
    const post = mock('post');
    const raw = mock('getRaw', { data: 'config: yaml' });
    const form = mock('postForm');
    await configApi.updateRequestLog(false);
    expect(put).toHaveBeenLastCalledWith('/config/observability/logs/request-log', false);
    await logsApi.fetchLogs({ limit: 10 });
    expect(get.mock.calls.at(-1)?.[0]).toBe('/observability/logs');
    await logsApi.fetchErrorLogs();
    expect(get.mock.calls.at(-1)?.[0]).toBe('/observability/logs/errors');
    await logsApi.downloadErrorLog('file.log');
    expect(raw.mock.calls.at(-1)?.[0]).toBe('/observability/logs/errors/file.log');
    await logsApi.downloadRequestLogById('request-id');
    expect(raw.mock.calls.at(-1)?.[0]).toBe('/observability/logs/requests/request-id');
    await versionApi.checkLatest();
    expect(get).toHaveBeenLastCalledWith('/server/latest-version');
    await apiKeyUsageApi.getUsage();
    expect(get.mock.calls.at(-1)?.[0]).toBe('/observability/usage/api-keys');
    await authFilesApi.resetCooldown('auth-index-1');
    expect(post).toHaveBeenLastCalledWith('/routing/cooldown/reset', {
      auth_index: 'auth-index-1',
    });
    await vertexApi.importCredential(new File(['{}'], 'fixture.json'));
    expect(form.mock.calls.at(-1)?.[0]).toBe('/oauth/import?provider=vertex');
    expect(await configFileApi.fetchConfigYaml()).toBe('config: yaml');
    expect(raw.mock.calls.at(-1)?.[0]).toBe('/config.yaml');
    await configFileApi.saveConfigYaml('config: yaml');
    expect(put.mock.calls.at(-1)?.slice(0, 2)).toEqual(['/config.yaml', 'config: yaml']);
  });
});
