/**
 * Source-contract regression test for PageTransition layer geometry: the absolute
 * exit/stacked-keep layers' `inset` must compensate for `.page-transition`'s own
 * padding on every side, or they resolve at a different rect than the normal-flow
 * current layer on every route change (the containing block for an absolutely
 * positioned child is the parent's padding box, which already includes that
 * padding; a normal-flow sibling's box does not).
 *
 * The padding/margin pair must be symmetric on all four sides (not just left/right)
 * so the `overflow: hidden` clip boundary clears edge-flush focus rings on every
 * edge of the page, not only the left and right.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { extractBlock } from './helpers/cssTokens';

const src = readFileSync(
  new URL('../src/components/common/PageTransition.scss', import.meta.url),
  'utf8'
);

const readUniformPadding = (): number => {
  const rootBlock = extractBlock(src, '.page-transition {');
  const match = rootBlock.match(/(?<!-)padding:\s*(\d+(?:\.\d+)?)px\s*;/);
  if (!match) throw new Error("could not find `.page-transition`'s own uniform `padding: Npx;`");
  return Number(match[1]);
};

const readUniformNegativeMargin = (): number => {
  const rootBlock = extractBlock(src, '.page-transition {');
  const match = rootBlock.match(/margin:\s*(-\d+(?:\.\d+)?)px\s*;/);
  if (!match) throw new Error("could not find `.page-transition`'s own uniform `margin: -Npx;`");
  return Number(match[1]);
};

const readUniformInset = (selector: string): number => {
  const block = extractBlock(src, selector);
  const match = block.match(/inset:\s*(\d+(?:\.\d+)?)px\s*;/);
  if (!match) throw new Error(`could not find a uniform "inset: Npx;" declaration in ${selector}`);
  return Number(match[1]);
};

describe('PageTransition clips edge-flush focus rings on every side, not just left/right', () => {
  const padding = readUniformPadding();
  const margin = readUniformNegativeMargin();

  test('.page-transition declares a non-zero, uniform (all-sides) padding', () => {
    expect(padding).toBeGreaterThan(0);
  });

  test('the negative margin exactly cancels the padding on all sides (no visible layout shift)', () => {
    expect(margin).toBe(-padding);
  });

  test("the exit layer's inset matches the parent's padding on all four sides", () => {
    expect(readUniformInset('&--exit {')).toBe(padding);
  });

  test("the stacked-keep layer's inset matches the parent's padding on all four sides", () => {
    expect(readUniformInset('&.page-transition__layer--stacked-keep {')).toBe(padding);
  });
});
