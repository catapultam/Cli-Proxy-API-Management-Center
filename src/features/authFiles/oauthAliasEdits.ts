import type { OAuthModelAliasEntry } from '@/types';

/**
 * Pure list edits behind the OAuth model alias actions. Each returns the next
 * list for one provider, or null when nothing changes. Entries other than the
 * target are returned as the same objects, so their raw config fields and key
 * spelling reach the write path untouched.
 */

const keyOf = (value: string | undefined): string => (value ?? '').trim().toLowerCase();

const isLink = (entry: OAuthModelAliasEntry, nameKey: string, aliasKey: string): boolean =>
  keyOf(entry.name) === nameKey && keyOf(entry.alias) === aliasKey;

export const addAliasLink = (
  mappings: OAuthModelAliasEntry[],
  sourceModel: string,
  alias: string
): OAuthModelAliasEntry[] | null => {
  const name = sourceModel.trim();
  const aliasTrim = alias.trim();
  if (!name || !aliasTrim) return null;
  if (mappings.some((entry) => isLink(entry, keyOf(name), keyOf(aliasTrim)))) return null;
  return [...mappings, { name, alias: aliasTrim, fork: true }];
};

export const removeAliasLink = (
  mappings: OAuthModelAliasEntry[],
  sourceModel: string,
  alias: string
): OAuthModelAliasEntry[] | null => {
  const nameKey = keyOf(sourceModel);
  const aliasKey = keyOf(alias);
  const next = mappings.filter((entry) => !isLink(entry, nameKey, aliasKey));
  return next.length === mappings.length ? null : next;
};

export const setAliasLinkFork = (
  mappings: OAuthModelAliasEntry[],
  sourceModel: string,
  alias: string,
  fork: boolean
): OAuthModelAliasEntry[] | null => {
  const nameKey = keyOf(sourceModel);
  const aliasKey = keyOf(alias);
  let changed = false;
  const next = mappings.map((entry) => {
    if (!isLink(entry, nameKey, aliasKey)) return entry;
    changed = true;
    return fork ? { ...entry, fork: true } : { ...entry, fork: undefined };
  });
  return changed ? next : null;
};

export const renameAliasInMappings = (
  mappings: OAuthModelAliasEntry[],
  oldAlias: string,
  newAlias: string
): OAuthModelAliasEntry[] | null => {
  const oldKey = keyOf(oldAlias);
  const newTrim = newAlias.trim();
  if (!oldKey || !newTrim) return null;
  let changed = false;
  const next = mappings.map((entry) => {
    if (keyOf(entry.alias) !== oldKey) return entry;
    changed = true;
    return { ...entry, alias: newTrim };
  });
  return changed ? next : null;
};

export const removeAliasFromMappings = (
  mappings: OAuthModelAliasEntry[],
  alias: string
): OAuthModelAliasEntry[] | null => {
  const aliasKey = keyOf(alias);
  const next = mappings.filter((entry) => keyOf(entry.alias) !== aliasKey);
  return next.length === mappings.length ? null : next;
};

const rawText = (entry: OAuthModelAliasEntry, field: 'name' | 'alias'): string | undefined => {
  if (!entry.raw) return undefined;
  const value =
    field === 'name' ? (entry.raw.name ?? entry.raw.id ?? entry.raw.model) : entry.raw.alias;
  return String(value ?? '').trim();
};

/** True when the row still has the name and alias it was read with. */
export const isUneditedAliasRow = (entry: OAuthModelAliasEntry): boolean =>
  entry.raw !== undefined &&
  rawText(entry, 'name') === (entry.name ?? '').trim() &&
  rawText(entry, 'alias') === (entry.alias ?? '').trim();

/**
 * Finds an alias collision the user introduced in the editor. Several upstream
 * names already sharing one alias in the config are left alone; a collision only
 * counts when a new row or a row whose alias was edited takes part in it.
 */
export const hasNewAliasConflict = (rows: OAuthModelAliasEntry[]): boolean => {
  const groups = new Map<string, OAuthModelAliasEntry[]>();
  rows.forEach((row) => {
    const aliasKey = keyOf(row.alias);
    if (!aliasKey || !(row.name ?? '').trim()) return;
    groups.set(aliasKey, [...(groups.get(aliasKey) ?? []), row]);
  });
  return Array.from(groups.values()).some(
    (group) =>
      group.length > 1 &&
      group.some((row) => !row.raw || rawText(row, 'alias') !== (row.alias ?? '').trim())
  );
};
