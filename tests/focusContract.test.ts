/**
 * Source-contract regression tests for the ui-refresh focus-visible pass.
 *
 * These check structural properties of the stylesheets (via `scanBlocks` in
 * tests/helpers/cssTokens.ts, a brace-matching scanner — not a flat regex guess)
 * rather than locking in one specific intermediate implementation, so a future
 * refactor of *how* focus is styled doesn't have to keep re-satisfying today's
 * mechanism as long as the underlying rules below still hold.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { listScssFiles, scanBlocks } from './helpers/cssTokens';

const readSource = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const allScssFiles = listScssFiles('src');
const allSources = allScssFiles.map((path) => ({ path, src: readSource(path) }));

describe('global focus-visible baseline', () => {
  const globalSrc = readSource('src/styles/global.scss');

  test('global.scss defines a keyboard-focus outline using the shared focus-ring token', () => {
    expect(globalSrc).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/);
  });

  test('the baseline rule sets a 2px outline-offset', () => {
    expect(globalSrc).toMatch(/:focus-visible\s*\{[^}]*outline-offset:\s*2px/);
  });
});

describe('the dead mouse-only focus-scoping pattern is gone', () => {
  // `&:focus:not(:focus-visible) { outline: none; ... }` cannot fire in Chromium
  // for text-like controls (input/textarea/select match :focus-visible there even
  // after a mouse click), so any such block is unreachable dead CSS.
  test('no stylesheet under src/ still contains the dead pattern', () => {
    const offenders = allSources
      .filter(({ src }) => src.includes(':focus:not(:focus-visible)'))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});

describe('every :focus-visible rule renders exactly one focus treatment', () => {
  // "One treatment" means the outline alone. A rule that also sets a box-shadow
  // next to its own `outline:` is the stacked double-ring bug: the outline comes
  // from this rule (or the global baseline) and the box-shadow paints a second,
  // differently-shaped ring around the same control at the same time.
  test('no focus-visible/focus-within rule pairs outline with a non-"none" box-shadow', () => {
    const offenders: string[] = [];
    for (const { path, src } of allSources) {
      for (const block of scanBlocks(src)) {
        if (!/:focus-(visible|within)/.test(block.selector)) continue;
        const hasOutline = /outline\s*:/.test(block.own);
        const hasBoxShadowRing = /box-shadow\s*:\s*(?!none\s*;)/.test(block.own);
        if (hasOutline && hasBoxShadowRing) {
          offenders.push(`${path} :: ${block.selector}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('one focus language: --focus-ring, not --primary-color, for keyboard rings', () => {
  test('no focus-visible/focus-within/focus rule still outlines with --primary-color', () => {
    const offenders: string[] = [];
    for (const { path, src } of allSources) {
      for (const block of scanBlocks(src)) {
        if (!/:focus(-visible|-within)?\b/.test(block.selector)) continue;
        if (/outline(-color)?\s*:[^;]*var\(--primary-color\)/.test(block.own)) {
          offenders.push(`${path} :: ${block.selector}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the shared button-reset mixin also uses the focus-ring token', () => {
    const mixinsSrc = readSource('src/styles/mixins.scss');
    const block = mixinsSrc.match(/@mixin button-reset\s*\{([\s\S]*?)\n\}/)?.[1];
    expect(block).toBeDefined();
    expect(block).toMatch(/outline:\s*2px solid var\(--focus-ring\)/);
  });
});

describe('no :focus rule (visible, within, or bare) stacks a second ring', () => {
  // A bare `:focus` rule that paints its own border-color/box-shadow ring stacks on
  // top of the global `:focus-visible` outline, since Chromium's text-like controls
  // match both selectors on the same click. This is broader than the box-shadow/
  // outline pairing check above: it
  // flags box-shadow or border-color in ANY `:focus`/`:focus-within`/`:focus-visible`
  // block, even when the ring-producing outline lives in a different rule (the global
  // baseline) rather than alongside it in the same block.
  //
  // Each allowlist entry below is a specific selector in a specific file, verified
  // against the real rule (not guessed from the class name) to declare something that
  // is not a focus ring: a background/foreground swap, or an opacity reveal.
  const ALLOWLIST: Record<string, string[]> = {};

  test('every :focus/:focus-within/:focus-visible block with box-shadow or border-color is allowlisted', () => {
    const offenders: string[] = [];
    for (const { path, src } of allSources) {
      for (const block of scanBlocks(src)) {
        if (!/:focus(-visible|-within)?\b/.test(block.selector)) continue;
        const hasBoxShadow = /box-shadow\s*:\s*(?!none\s*;)/.test(block.own);
        const hasBorderColor =
          /\bborder(-top|-right|-bottom|-left)?(-color)?\s*:\s*(?!none\s*;|0\s*;|transparent\s*;)[^;]+;/.test(
            block.own
          );
        if (!hasBoxShadow && !hasBorderColor) continue;
        const allowed = (ALLOWLIST[path] ?? []).some((sel) => block.selector.includes(sel));
        if (!allowed) {
          offenders.push(`${path} :: ${block.selector}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('ToggleSwitch and SelectionCheckbox keyboard focus', () => {
  test('ToggleSwitch renders an outline on input:focus-visible + .track', () => {
    const src = readSource('src/components/ui/ToggleSwitch.module.scss');
    expect(src).toMatch(
      /input:focus-visible\s*\+\s*\.track\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/
    );
  });

  test('SelectionCheckbox renders a single outline, not a stacked ring, on focus', () => {
    const src = readSource('src/components/ui/SelectionCheckbox.module.scss');
    const block = src.match(/\.input:focus-visible \+ \.box\s*\{([\s\S]*?)\}/)?.[1];
    expect(block).toBeDefined();
    expect(block).toMatch(/outline:\s*2px solid var\(--focus-ring\)/);
    expect(block).not.toMatch(/box-shadow/);
    expect(block).not.toMatch(/border-color/);
  });
});
