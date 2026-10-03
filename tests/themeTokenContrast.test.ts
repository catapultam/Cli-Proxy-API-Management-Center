/**
 * Source-contract regression tests for theme/control token contrast.
 *
 * These do not paint pixels in a browser; they resolve the actual CSS custom
 * properties the real selectors reference (via tests/helpers/cssTokens.ts) and
 * compute real WCAG contrast ratios from them. Each test targets a specific
 * token pair, not an arbitrary decorative value.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  extractBlock,
  parseDeclarations,
  resolveToken,
  resolveValue,
  firstTopLevelDeclaration,
  contrastRatio,
  relativeLuminance,
  listScssFiles,
  scanBlocks,
} from './helpers/cssTokens';

const readSource = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const themesSrc = readSource('src/styles/themes.scss');
const componentsSrc = readSource('src/styles/components.scss');
const toggleSrc = readSource('src/components/ui/ToggleSwitch.module.scss');
const checkboxSrc = readSource('src/components/ui/SelectionCheckbox.module.scss');

const rootScope = () => parseDeclarations(extractBlock(themesSrc, ':root'));
const whiteScope = () => parseDeclarations(extractBlock(themesSrc, "[data-theme='white']"));
const darkScope = () => parseDeclarations(extractBlock(themesSrc, "[data-theme='dark']"));

type ThemeName = 'light' | 'white' | 'dark';

function scopesFor(theme: ThemeName): Map<string, string>[] {
  const root = rootScope();
  if (theme === 'light') return [root];
  if (theme === 'white') return [whiteScope(), root];
  return [darkScope(), root];
}

const THEMES: ThemeName[] = ['light', 'white', 'dark'];

describe('theme token contrast (source contract, not pixel painting)', () => {
  describe.each(THEMES)('%s theme', (theme) => {
    const scopes = () => scopesFor(theme);

    test('text-tertiary clears 4.5:1 against bg-primary (card)', () => {
      const tertiary = resolveToken('--text-tertiary', scopes());
      const card = resolveToken('--bg-primary', scopes());
      expect(contrastRatio(tertiary, card)).toBeGreaterThanOrEqual(4.5);
    });

    test('text-tertiary clears 4.5:1 against bg-tertiary (hover surface)', () => {
      const tertiary = resolveToken('--text-tertiary', scopes());
      const hover = resolveToken('--bg-tertiary', scopes());
      expect(contrastRatio(tertiary, hover)).toBeGreaterThanOrEqual(4.5);
    });

    test('text-tertiary clears 4.5:1 against surface-sidebar', () => {
      const tertiary = resolveToken('--text-tertiary', scopes());
      const sidebar = resolveToken('--surface-sidebar', scopes());
      expect(contrastRatio(tertiary, sidebar)).toBeGreaterThanOrEqual(4.5);
    });

    test('action-fg clears 4.5:1 against action-bg', () => {
      const fg = resolveToken('--action-fg', scopes());
      const bg = resolveToken('--action-bg', scopes());
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    });

    test('action-fg clears 4.5:1 against action-bg-hover', () => {
      const fg = resolveToken('--action-fg', scopes());
      const bgHover = resolveToken('--action-bg-hover', scopes());
      expect(contrastRatio(fg, bgHover)).toBeGreaterThanOrEqual(4.5);
    });

    test('control-border clears 3:1 against the page background', () => {
      const border = resolveToken('--control-border', scopes());
      const page = resolveToken('--bg-secondary', scopes());
      expect(contrastRatio(border, page)).toBeGreaterThanOrEqual(3);
    });

    test('control-border clears 3:1 against the card background', () => {
      const border = resolveToken('--control-border', scopes());
      const card = resolveToken('--bg-primary', scopes());
      expect(contrastRatio(border, card)).toBeGreaterThanOrEqual(3);
    });

    test('control-border clears 3:1 against the sidebar background', () => {
      const border = resolveToken('--control-border', scopes());
      const sidebar = resolveToken('--surface-sidebar', scopes());
      expect(contrastRatio(border, sidebar)).toBeGreaterThanOrEqual(3);
    });

    test('the login brand panel background is visibly distinct from the page background', () => {
      const brand = resolveToken('--login-brand-bg', scopes());
      const page = resolveToken('--bg-secondary', scopes());
      // Not a WCAG text pair; this just asserts the two-panel split in LoginPage
      // stays visible (identical hex values would make the split invisible).
      expect(brand.toLowerCase()).not.toBe(page.toLowerCase());
    });
  });

  test("dark theme's login-brand-bg is its own value, not inherited from :root", () => {
    // `resolveToken` falls back to :root for an unset property, so a dark block
    // that omits --login-brand-bg would silently resolve to the light value and
    // this suite would never catch it. Assert the property is actually declared
    // inside the dark block itself.
    const darkBlock = extractBlock(themesSrc, "[data-theme='dark']");
    expect(parseDeclarations(darkBlock).has('--login-brand-bg')).toBe(true);
  });

  test('.btn-primary resolves a fg/bg pair that clears 4.5:1 in light theme', () => {
    const block = componentsSrc.match(/&\.btn-primary\s*\{([\s\S]*?)\n\s{2}&:hover/)?.[1];
    expect(block).toBeDefined();
    const bgRef = firstTopLevelDeclaration(block!, 'background-color');
    const fgRef = firstTopLevelDeclaration(block!, 'color');
    const root = rootScope();
    const bg = resolveValue(bgRef, [root]);
    const fg = resolveValue(fgRef, [root]);
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  test('dark theme does not force white text onto .btn-primary via a same-specificity rule', () => {
    const darkBlock = extractBlock(componentsSrc, "[data-theme='dark']");
    expect(darkBlock).not.toMatch(/(^|\n)[ \t]*\.btn[ \t]*\{\s*\n\s*color:\s*#fff;/);
  });

  test('SelectionCheckbox checked fill/icon pair clears 4.5:1 in light theme', () => {
    const boxBlock = extractBlock(checkboxSrc, '.box {');
    const checkedBlock = extractBlock(checkboxSrc, '.boxChecked {');
    const fgRef = firstTopLevelDeclaration(boxBlock, 'color');
    const bgRef = firstTopLevelDeclaration(checkedBlock, 'background');
    const root = rootScope();
    const fg = resolveValue(fgRef, [root]);
    const bg = resolveValue(bgRef, [root]);
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  test('ToggleSwitch unchecked thumb clears 3:1 against its track in light theme', () => {
    const trackBlock = extractBlock(toggleSrc, '.track {');
    const trackBgRef = firstTopLevelDeclaration(trackBlock, 'background');
    const thumbBlock = extractBlock(toggleSrc, '.thumb {');
    const thumbBgRaw = firstTopLevelDeclaration(thumbBlock, 'background');
    const root = rootScope();
    const track = resolveValue(trackBgRef, [root]);
    const thumb = resolveValue(thumbBgRaw, [root]);
    expect(contrastRatio(thumb, track)).toBeGreaterThanOrEqual(3);
  });

  test('ToggleSwitch unchecked thumb clears 3:1 against its track in dark theme', () => {
    const trackBlock = extractBlock(toggleSrc, '.track {');
    const trackBgRef = firstTopLevelDeclaration(trackBlock, 'background');
    const thumbBlock = extractBlock(toggleSrc, '.thumb {');
    const thumbBgRaw = firstTopLevelDeclaration(thumbBlock, 'background');
    const dark = darkScope();
    const root = rootScope();
    const track = resolveValue(trackBgRef, [dark, root]);
    const thumb = resolveValue(thumbBgRaw, [dark, root]);
    expect(contrastRatio(thumb, track)).toBeGreaterThanOrEqual(3);
  });

  test('ToggleSwitch checked track/thumb pair clears 3:1 in light theme', () => {
    const checkedTrackBlock = extractBlock(toggleSrc, '.root input:checked + .track {');
    const trackBgRef = firstTopLevelDeclaration(checkedTrackBlock, 'background');
    const checkedThumbBlock = extractBlock(toggleSrc, '.root input:checked + .track .thumb {');
    const thumbBgRef = firstTopLevelDeclaration(checkedThumbBlock, 'background');
    const root = rootScope();
    const track = resolveValue(trackBgRef, [root]);
    const thumb = resolveValue(thumbBgRef, [root]);
    expect(contrastRatio(thumb, track)).toBeGreaterThanOrEqual(3);
  });
});

describe('surface separation: page, sidebar, card, and hover must each be visually distinguishable', () => {
  // A contrast ratio of 1.0 means identical colours. These assert a real,
  // visible margin between adjacent surfaces, so e.g. hovering a sidebar item
  // always paints a visible change against both the sidebar and the page.
  const MIN_DISTINCT_RATIO = 1.04;

  test('light theme: sidebar is visibly distinct from the page background', () => {
    const page = resolveToken('--bg-secondary', [rootScope()]);
    const sidebar = resolveToken('--surface-sidebar', [rootScope()]);
    expect(contrastRatio(page, sidebar)).toBeGreaterThanOrEqual(MIN_DISTINCT_RATIO);
  });

  test('light theme: card is the lightest of page/sidebar/card', () => {
    const page = relativeLuminance(resolveToken('--bg-secondary', [rootScope()]));
    const sidebar = relativeLuminance(resolveToken('--surface-sidebar', [rootScope()]));
    const card = relativeLuminance(resolveToken('--bg-primary', [rootScope()]));
    expect(card).toBeGreaterThan(page);
    expect(card).toBeGreaterThan(sidebar);
  });

  test('white theme: sidebar is visibly distinct from the page background', () => {
    const scopes = [whiteScope(), rootScope()];
    const page = resolveToken('--bg-secondary', scopes);
    const sidebar = resolveToken('--surface-sidebar', scopes);
    expect(contrastRatio(page, sidebar)).toBeGreaterThanOrEqual(MIN_DISTINCT_RATIO);
  });

  test('white theme: hover (--bg-tertiary) is not the same colour as the sidebar', () => {
    const scopes = [whiteScope(), rootScope()];
    const sidebar = resolveToken('--surface-sidebar', scopes);
    const hover = resolveToken('--bg-tertiary', scopes);
    expect(hover.toLowerCase()).not.toBe(sidebar.toLowerCase());
    expect(contrastRatio(sidebar, hover)).toBeGreaterThanOrEqual(MIN_DISTINCT_RATIO);
  });

  test('white theme: hover (--bg-tertiary) is not the same colour as the page background', () => {
    const scopes = [whiteScope(), rootScope()];
    const page = resolveToken('--bg-secondary', scopes);
    const hover = resolveToken('--bg-tertiary', scopes);
    expect(hover.toLowerCase()).not.toBe(page.toLowerCase());
    expect(contrastRatio(page, hover)).toBeGreaterThanOrEqual(MIN_DISTINCT_RATIO);
  });

  test('light theme: sidebar is not the same colour as hover (--bg-tertiary)', () => {
    const sidebar = resolveToken('--surface-sidebar', [rootScope()]);
    const hover = resolveToken('--bg-tertiary', [rootScope()]);
    expect(hover.toLowerCase()).not.toBe(sidebar.toLowerCase());
  });
});

describe('no primary-action rule still uses the old ink pair', () => {
  // What this guards against: a button-like rule whose own declarations pair a
  // solid `background: var(--primary-color)` with a light foreground text colour
  // (`--primary-contrast`, or a literal #fff/white). That pairing is a different,
  // lower-contrast "primary" treatment than .btn-primary's --action-bg/--action-fg
  // pair. This scans every *.scss file under src/ (not a hand-maintained list, and
  // not only *.module.scss), so a new offender in any stylesheet fails immediately.
  test('no rule anywhere pairs a solid --primary-color background with light text', () => {
    const offenders: string[] = [];
    for (const path of listScssFiles('src')) {
      const src = readSource(path);
      for (const block of scanBlocks(src)) {
        const hasPrimaryBg = /background(-color)?\s*:\s*var\(--primary-color\)\s*;/.test(block.own);
        const hasLightFg = /color\s*:\s*(var\(--primary-contrast\)|#fff(?:fff)?|white)\s*;/i.test(
          block.own
        );
        if (hasPrimaryBg && hasLightFg) {
          offenders.push(`${path} :: ${block.selector}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
