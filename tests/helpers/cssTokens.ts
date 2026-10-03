/**
 * Minimal CSS custom-property resolver + WCAG contrast helper for source-contract tests.
 *
 * This is intentionally narrow: it understands the subset of SCSS the theme/token
 * files actually use (hex literals, `var(--x)` / `var(--x, fallback)`, and a theme
 * block falling back to `:root` the way the real cascade does for an unset custom
 * property). It is not a CSS parser; non-hex, non-var values are a loud failure
 * rather than a silent guess.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Recursively lists every `.scss` file under `root` (relative to the repo root), sorted. */
export function listScssFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(new URL(`../../${dir}`, import.meta.url), {
      withFileTypes: true,
    })) {
      const entryPath = join(dir, entry.name).replace(/\\/g, '/');
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.name.endsWith('.scss')) out.push(entryPath);
    }
  };
  walk(root);
  return out.sort();
}

export function extractBlock(source: string, selector: string): string {
  const idx = source.indexOf(selector);
  if (idx === -1) throw new Error(`selector not found in source: ${selector}`);
  const braceStart = source.indexOf('{', idx);
  if (braceStart === -1) throw new Error(`no opening brace after selector: ${selector}`);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(braceStart + 1, i);
    }
  }
  throw new Error(`unterminated block for selector: ${selector}`);
}

function stripLineComment(line: string): string {
  const idx = line.indexOf('//');
  return idx === -1 ? line : line.slice(0, idx);
}

/** Parses only the custom-property declarations (`--foo: ...;`) directly in a block. */
export function parseDeclarations(block: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of block.split('\n')) {
    const line = stripLineComment(rawLine).trim();
    const match = line.match(/^(--[\w-]+)\s*:\s*(.+)$/);
    if (!match) continue;
    const value = match[2].replace(/;\s*$/, '').trim();
    map.set(match[1], value);
  }
  return map;
}

/** First top-level (non-nested) declaration for a property, e.g. `color:` or `background:`. */
export function firstTopLevelDeclaration(block: string, property: string): string {
  const re = new RegExp(`^[ \\t]*${property}\\s*:\\s*([^;]+);`, 'm');
  const match = block.match(re);
  if (!match) throw new Error(`no top-level "${property}:" declaration found`);
  return match[1].trim();
}

function hexToRgbTuple(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3 || h.length === 4) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const num = parseInt(h.slice(0, 6), 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function rgbTupleToHex([r, g, b]: [number, number, number]): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('')}`;
}

/** Linear sRGB-component blend, matching `color-mix(in srgb, A P%, B)`. */
function mixSrgbHex(hexA: string, percentA: number, hexB: string): string {
  const a = hexToRgbTuple(hexA);
  const b = hexToRgbTuple(hexB);
  const t = percentA / 100;
  const mixed = a.map((channel, i) => channel * t + b[i] * (1 - t)) as [number, number, number];
  return rgbTupleToHex(mixed);
}

export function resolveValue(
  raw: string,
  scopes: Map<string, string>[],
  seen: Set<string> = new Set()
): string {
  const trimmed = raw.trim();
  const mixMatch = trimmed.match(/^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*(.+)\)$/);
  if (mixMatch) {
    const [, rawA, percent, rawB] = mixMatch;
    const a = resolveValue(rawA.trim(), scopes, seen);
    const b = resolveValue(rawB.trim(), scopes, seen);
    return mixSrgbHex(a, Number(percent), b);
  }
  const varMatch = trimmed.match(/^var\((--[\w-]+)\s*(?:,\s*(.+))?\)$/);
  if (varMatch) {
    const [, refName, fallback] = varMatch;
    if (seen.has(refName)) throw new Error(`circular var() reference: ${refName}`);
    for (const scope of scopes) {
      if (scope.has(refName)) {
        const next = new Set(seen);
        next.add(refName);
        return resolveValue(scope.get(refName)!, scopes, next);
      }
    }
    if (fallback !== undefined) return resolveValue(fallback.trim(), scopes, seen);
    throw new Error(`unresolved var(${refName}) with no fallback and no scope defines it`);
  }
  if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) return trimmed;
  throw new Error(`cannot resolve non-hex, non-var(), non-color-mix value: "${trimmed}"`);
}

/** Resolves a token name against a cascade of scopes (most specific first). */
export function resolveToken(name: string, scopes: Map<string, string>[]): string {
  for (const scope of scopes) {
    if (scope.has(name)) return resolveValue(scope.get(name)!, scopes);
  }
  throw new Error(`token not defined in any scope: ${name}`);
}

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3 || h.length === 4) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const num = parseInt(h.slice(0, 6), 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function channelLuminance(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** WCAG 2.x contrast ratio between two opaque hex colors. */
export function contrastRatio(hexA: string, hexB: string): number {
  const l1 = relativeLuminance(hexA);
  const l2 = relativeLuminance(hexB);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

export interface ScannedBlock {
  /** The selector line (or last line of a multi-line selector) immediately before `{`. */
  selector: string;
  /** This block's own declarations, with any nested rule bodies stripped out. */
  own: string;
}

/**
 * Walks every brace-delimited block in a stylesheet (rules, nested rules, @media
 * bodies — everything) and returns each one's selector plus its *own* declarations
 * (nested rule bodies removed, so a parent rule's `own` text doesn't falsely
 * include a child selector's declarations). Used for mechanical, structural
 * source-contract checks that need to know what a specific selector itself
 * declares, as opposed to a flat text/regex search over the whole file.
 */
export function scanBlocks(source: string): ScannedBlock[] {
  const blocks: ScannedBlock[] = [];
  const openStack: number[] = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '{') {
      openStack.push(i);
    } else if (source[i] === '}') {
      const start = openStack.pop();
      if (start === undefined) continue;
      const prevClose = source.lastIndexOf('}', start - 1);
      const selectorStart = prevClose === -1 ? 0 : prevClose + 1;
      const selectorLines = source
        .slice(selectorStart, start)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const selector = selectorLines[selectorLines.length - 1] ?? '';
      const raw = source.slice(start + 1, i);
      let own = raw;
      let prev: string;
      do {
        prev = own;
        own = own.replace(/\{[^{}]*\}/g, '');
      } while (own !== prev);
      blocks.push({ selector, own });
    }
  }
  return blocks;
}
