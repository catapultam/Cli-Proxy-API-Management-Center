/**
 * Source-contract regression test: the selected row in the AI Providers sidebar
 * list (ProviderCategoryList) must colour its text with `--text-primary` (the
 * same lifted-selection ink treatment as the main sidebar's active nav item),
 * not the muted `--primary-color` token, which reads as disabled/greyed-out
 * next to the page's normal ink text.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { extractBlock } from './helpers/cssTokens';

const src = readFileSync(
  new URL('../src/features/providers/components/ProviderCategoryList.module.scss', import.meta.url),
  'utf8'
);

describe('ProviderCategoryList selected row uses ink text, not a muted primary-color wash', () => {
  test('.item.active (the generic, non-brand-specific selection) colours text with --text-primary', () => {
    const block = extractBlock(src, '&.active {');
    expect(block).toMatch(/color\s*:\s*var\(--text-primary\)/);
    expect(block).not.toMatch(/color\s*:\s*var\(--primary-color\)/);
  });

  test('.itemSubtitle under .active does not fall back to --primary-color either', () => {
    const block = extractBlock(src, '.active & {');
    expect(block).not.toMatch(/var\(--primary-color\)/);
  });
});
