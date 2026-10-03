/**
 * Source-contract regression test guarding against "page title sits at different
 * heights on different routes". `.main-content` (styles/layout.scss) establishes
 * the one true top offset: `calc(var(--header-height) + 16px)`. Any route that
 * hard-codes its own top padding, or stacks a second top padding on top of
 * `.main-content`'s, drifts out of alignment with every other route.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { extractBlock } from './helpers/cssTokens';

const HEADER_OFFSET = /calc\(var\(--header-height\)\s*\+\s*16px\)/;

const readSource = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('top offset uses the shared --header-height var, not a stale literal', () => {
  test('.main-content itself uses the shared offset', () => {
    const src = readSource('src/styles/layout.scss');
    const block = extractBlock(src, '.main-content {');
    expect(block).toMatch(HEADER_OFFSET);
  });

  test('.main-content-logs uses the same offset, not a literal px value', () => {
    const src = readSource('src/styles/layout.scss');
    const block = extractBlock(src, '&.main-content-logs {');
    expect(block).toMatch(HEADER_OFFSET);
    expect(block).not.toMatch(/padding:\s*70px/);
  });

  test('PluginResourcePage .stateShell uses the same offset, not a literal px value', () => {
    const src = readSource('src/features/plugins/PluginResourcePage.module.scss');
    const block = extractBlock(src, '.stateShell {');
    expect(block).toMatch(HEADER_OFFSET);
    expect(block).not.toMatch(/padding:\s*70px/);
  });

  test("ProvidersWorkbenchPage .page does not stack its own top padding on .main-content's", () => {
    const src = readSource('src/features/providers/ProvidersWorkbenchPage.module.scss');
    const block = extractBlock(src, '.page {');
    expect(block).not.toMatch(/padding(-top)?\s*:/);
  });
});
