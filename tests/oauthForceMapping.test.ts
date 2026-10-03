import { describe, expect, test } from 'bun:test';
import {
  normalizeOauthModelAlias,
  serializeOauthModelAliases,
} from '../src/services/api/authFiles';

describe('OAuth model alias force mapping', () => {
  test('reads force-mapping and writes unchanged entries back verbatim', () => {
    const stored = [
      { name: 'gpt-source', alias: 'gpt-alias', 'force-mapping': true },
      { name: 'gpt-source-2', alias: 'gpt-alias-2', forceMapping: false },
    ];
    const normalized = normalizeOauthModelAlias({ codex: stored });

    expect(
      normalized.codex.map(({ name, alias, forceMapping }) => ({ name, alias, forceMapping }))
    ).toEqual([
      { name: 'gpt-source', alias: 'gpt-alias', forceMapping: true },
      { name: 'gpt-source-2', alias: 'gpt-alias-2', forceMapping: false },
    ]);
    expect(serializeOauthModelAliases(normalized.codex)).toEqual(stored);
  });

  test('an edited force-mapping is written under the proxy key', () => {
    const normalized = normalizeOauthModelAlias({
      codex: [
        { name: 'gpt-source', alias: 'gpt-alias', 'force-mapping': true },
        { name: 'gpt-source-2', alias: 'gpt-alias-2', forceMapping: false },
      ],
    });
    const edited = normalized.codex.map((entry) => ({
      ...entry,
      forceMapping: !entry.forceMapping,
    }));

    expect(serializeOauthModelAliases(edited)).toEqual([
      { name: 'gpt-source', alias: 'gpt-alias', 'force-mapping': false },
      { name: 'gpt-source-2', alias: 'gpt-alias-2', 'force-mapping': true },
    ]);
    expect(
      serializeOauthModelAliases([{ name: 'new', alias: 'fresh', forceMapping: true }])
    ).toEqual([{ name: 'new', alias: 'fresh', 'force-mapping': true }]);
  });
});
