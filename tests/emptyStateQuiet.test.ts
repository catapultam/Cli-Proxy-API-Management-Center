/**
 * Source-contract regression test: the quiet EmptyState title rule must out-specify
 * the base `.empty-state .empty-title` rule (0,2,0) by nesting under the variant
 * class — `.empty-state.empty-state--quiet .empty-title` (0,3,0) — rather than
 * relying on a same-specificity sibling rule that only wins by source order.
 *
 * It must also still read as a heading over the description under it: weight 500-600
 * in --text-primary, not the same weight/color as --empty-desc (that made a quiet
 * empty state's title and description visually indistinguishable). Load-failure
 * states use the separate `error` variant instead of `quiet`, so they read as an
 * error rather than a calm "nothing here yet" message.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { extractBlock } from './helpers/cssTokens';

const componentsScss = readFileSync(
  new URL('../src/styles/components.scss', import.meta.url),
  'utf8'
);
const emptyStateTsx = readFileSync(
  new URL('../src/components/ui/EmptyState.tsx', import.meta.url),
  'utf8'
);

function expectHeadingHierarchy(variantBlock: string) {
  const titleOverride = extractBlock(variantBlock, '.empty-title {');
  const weightMatch = titleOverride.match(/font-weight:\s*(\d+)/);
  expect(weightMatch).not.toBeNull();
  const weight = Number(weightMatch![1]);
  expect(weight).toBeGreaterThanOrEqual(500);
  expect(weight).toBeLessThanOrEqual(600);
  expect(titleOverride).toMatch(/color:\s*var\(--text-primary\)/);
}

describe('quiet EmptyState title rule out-specifies the base rule', () => {
  const block = extractBlock(componentsScss, '.empty-state {');

  test('the quiet variant is nested under `.empty-state` (not a same-specificity sibling rule)', () => {
    expect(block).toMatch(/&\.empty-state--quiet\s*\{/);
  });

  test('the nested quiet block overrides `.empty-title` to still read as a heading (weight 500-600, primary text), not fade to the description\'s weight/color', () => {
    const quietBlock = extractBlock(block, '&.empty-state--quiet {');
    expectHeadingHierarchy(quietBlock);
  });

  test('there is no standalone top-level `.empty-state--quiet {` rule tying on specificity with the base rule', () => {
    const afterBlock = componentsScss.slice(componentsScss.indexOf(block) + block.length);
    expect(afterBlock.slice(0, 400)).not.toMatch(/^\s*\}\s*\n\s*\.empty-state--quiet\s*\{/);
  });

  test('the quiet variant gets real padding and centered alignment (not flush against the host card)', () => {
    const quietBlock = extractBlock(block, '&.empty-state--quiet {');
    const paddingMatch = quietBlock.match(/(?<!-)padding:\s*(\d+(?:\.\d+)?)px/);
    expect(paddingMatch).not.toBeNull();
    expect(Number(paddingMatch![1])).toBeGreaterThanOrEqual(24);
    expect(Number(paddingMatch![1])).toBeLessThanOrEqual(32);
    expect(quietBlock).toMatch(/text-align:\s*center/);
  });

  test('the base .empty-desc declares a deterministic 13-14px size (not inherited from ambient context)', () => {
    const descBlock = extractBlock(block, '.empty-desc {');
    const sizeMatch = descBlock.match(/font-size:\s*(\d+(?:\.\d+)?)px/);
    expect(sizeMatch).not.toBeNull();
    expect(Number(sizeMatch![1])).toBeGreaterThanOrEqual(13);
    expect(Number(sizeMatch![1])).toBeLessThanOrEqual(14);
    expect(descBlock).toMatch(/color:\s*var\(--text-secondary\)/);
  });
});

describe('the error variant reads as an error, not a calm empty state', () => {
  const block = extractBlock(componentsScss, '.empty-state {');

  test('a distinct `error` variant exists, nested like `quiet`', () => {
    expect(block).toMatch(/&\.empty-state--error\s*\{/);
  });

  test('its title also keeps heading weight/color, but tinted as a failure', () => {
    const errorBlock = extractBlock(block, '&.empty-state--error {');
    const titleOverride = extractBlock(errorBlock, '.empty-title {');
    const weightMatch = titleOverride.match(/font-weight:\s*(\d+)/);
    expect(weightMatch).not.toBeNull();
    expect(Number(weightMatch![1])).toBeGreaterThanOrEqual(500);
    expect(titleOverride).toMatch(/color:\s*var\(--failure-badge-text\)/);
  });

  test('EmptyState.tsx renders an alert icon for the error variant', () => {
    expect(emptyStateTsx).toMatch(/IconAlertTriangle/);
    expect(emptyStateTsx).toMatch(/variant\?:\s*'card'\s*\|\s*'quiet'\s*\|\s*'error'/);
  });

  test('load-failure call sites use `error`, not `quiet`', () => {
    const loadFailureSites = [
      '../src/features/authFiles/components/OAuthExcludedCard.tsx',
      '../src/features/authFiles/components/OAuthModelAliasCard.tsx',
      '../src/pages/AuthFilesOAuthExcludedEditPage.tsx',
      '../src/pages/AuthFilesOAuthModelAliasEditPage.tsx',
    ];
    for (const relativePath of loadFailureSites) {
      const src = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      // The refresh_failed / initialLoadError branch's EmptyState must be `error`.
      const refreshFailedIdx = src.indexOf("t('notification.refresh_failed')");
      expect(refreshFailedIdx).toBeGreaterThan(-1);
      const emptyStateStart = src.lastIndexOf('<EmptyState', refreshFailedIdx);
      expect(emptyStateStart).toBeGreaterThan(-1);
      const slice = src.slice(emptyStateStart, refreshFailedIdx);
      expect(slice).toMatch(/variant="error"/);
    }
  });
});

describe('the dead `.empty-title--quiet` class is gone', () => {
  test('EmptyState.tsx no longer renders it', () => {
    expect(emptyStateTsx).not.toContain('empty-title--quiet');
  });

  test('components.scss no longer declares a standalone `.empty-title--quiet` rule', () => {
    expect(componentsScss).not.toMatch(/\.empty-title--quiet\s*\{/);
  });
});
