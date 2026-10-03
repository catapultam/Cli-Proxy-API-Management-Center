/**
 * Source-contract regression test: SelectionCheckbox's hover ring and Select's
 * `[aria-expanded='true']` ring must share one non-tinted "interactive" vocabulary
 * with every other hover/focus state in the app (darken a border, or use
 * `--focus-ring`) rather than painting a tinted `--primary-color` halo.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { extractBlock } from './helpers/cssTokens';

const checkboxSrc = readFileSync(
  new URL('../src/components/ui/SelectionCheckbox.module.scss', import.meta.url),
  'utf8'
);
const selectSrc = readFileSync(
  new URL('../src/components/ui/Select.module.scss', import.meta.url),
  'utf8'
);

describe('SelectionCheckbox and Select share one non-tinted affordance language', () => {
  test('SelectionCheckbox hover darkens the border; no primary-color, no box-shadow ring', () => {
    const block = extractBlock(checkboxSrc, '.root:hover .box {');
    expect(block).not.toMatch(/--primary-color/);
    expect(block).not.toMatch(/box-shadow/);
    expect(block).toMatch(/border-color\s*:\s*var\(--text-secondary\)/);
  });

  test("Select's [aria-expanded='true'] darkens the border; no primary-color ring", () => {
    const block = extractBlock(selectSrc, "&[aria-expanded='true'] {");
    expect(block).not.toMatch(/--primary-color/);
    expect(block).not.toMatch(/\$primary-color/);
    expect(block).toMatch(/border-color\s*:\s*var\(--text-secondary\)/);
  });
});
