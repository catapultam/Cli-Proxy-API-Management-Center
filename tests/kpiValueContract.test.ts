/**
 * Source-contract regression test: a dashboard KPI value must never wrap a long
 * number mid-digit (e.g. "1,234,567" breaking into "1,234,5" / "67") in the
 * 2-column KPI grid. `white-space: nowrap` plus a container-relative font-size
 * keeps the number on one line, shrinking it to fit its own tile's actual width
 * instead of wrapping or overflowing. Verified pixel-for-pixel in the browser at
 * 360/390/500/700/900/1024/1440px.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { extractBlock } from './helpers/cssTokens';

const src = readFileSync(
  new URL('../src/features/dashboard/dashboard.module.scss', import.meta.url),
  'utf8'
);

describe('dashboard KPI value never wraps a number mid-digit', () => {
  test('.statTile establishes an inline-size container (so .statValue can size off it)', () => {
    const block = extractBlock(src, '.statTile {');
    expect(block).toMatch(/container-type:\s*inline-size\s*;/);
  });

  test('.statValue uses white-space: nowrap, not overflow-wrap: break-word', () => {
    const block = extractBlock(src, '.statValue {');
    expect(block).toMatch(/white-space:\s*nowrap\s*;/);
    expect(block).not.toMatch(/overflow-wrap\s*:\s*break-word/);
  });

  test('.statValue sizes its font off the container (cqi), not a fixed px or vw value', () => {
    const block = extractBlock(src, '.statValue {');
    const match = block.match(/font-size:\s*clamp\(([^)]+)\)\s*;/);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/cqi/);
  });
});
