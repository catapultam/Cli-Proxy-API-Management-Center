/**
 * Source-contract regression test for Host/Port/Proxy (and every other field sharing
 * a FieldGrid row with them) input-top alignment.
 *
 * FieldGrid is `repeat(auto-fit, minmax($field-col-min, 1fr))`, so the number of
 * tracks that fit a given container width is a deterministic function of that width
 * (unlike a viewport media-query breakpoint, which does not track the grid's real
 * column count under font-size changes, zoom, or a different container). Each field
 * that can land in the same row as the sponsor-hint field (Proxy URL) therefore gets
 * an invisible `.fieldSponsorSpacer` placeholder that only takes up space once a
 * `@container` query confirms enough tracks fit for that field's row to actually
 * contain the sponsor field — not unconditionally, and not hidden by a viewport
 * breakpoint.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { extractBlock } from './helpers/cssTokens';

const fieldScss = readFileSync(
  new URL('../src/features/config/components/fields/Field.module.scss', import.meta.url),
  'utf8'
);
const sharedFieldsTsx = readFileSync(
  new URL('../src/features/config/components/fields/sharedFields.tsx', import.meta.url),
  'utf8'
);
const sectionNetworkTsx = readFileSync(
  new URL('../src/features/config/components/sections/SectionNetwork.tsx', import.meta.url),
  'utf8'
);
const sectionCommonTsx = readFileSync(
  new URL('../src/features/config/components/sections/SectionCommon.tsx', import.meta.url),
  'utf8'
);

describe('the old font-metric-dependent hacks are gone', () => {
  test('.fieldSponsorLink no longer compensates with a negative vertical margin', () => {
    const block = extractBlock(fieldScss, '.fieldSponsorLink {');
    expect(block).not.toMatch(/margin:\s*-\d/);
  });

  test('.fieldSponsorLink instead pins a deterministic border-box height', () => {
    const block = extractBlock(fieldScss, '.fieldSponsorLink {');
    expect(block).toMatch(/box-sizing:\s*border-box/);
    expect(block).toMatch(/height:\s*\d+(\.\d+)?px/);
  });

  test('.fieldSponsorHint is a fixed-height row, not line-height-driven', () => {
    // A line box around the inline-flex sponsor badge rounds up past the badge's own
    // height unless the row itself pins a height — that 2px rounding is what desynced
    // this row from .fieldSponsorSpacer's identical-looking placeholder.
    const block = extractBlock(fieldScss, '.fieldSponsorHint {');
    expect(block).toMatch(/display:\s*flex/);
    expect(block).toMatch(/height:\s*\d+(\.\d+)?px/);
  });
});

describe('.fieldSponsorSpacer only takes space when it actually shares the sponsor row', () => {
  test('hidden by default (no viewport-breakpoint hide, no unconditional min-height)', () => {
    const block = extractBlock(fieldScss, '.fieldSponsorSpacer {');
    expect(block).toMatch(/display:\s*none/);
  });

  test('.fieldSponsorHint and .fieldSponsorSpacer declare the same deterministic height', () => {
    const hint = extractBlock(fieldScss, '.fieldSponsorHint {');
    const spacer = extractBlock(fieldScss, '.fieldSponsorSpacer {');
    const hintHeight = hint.match(/height:\s*(\d+(?:\.\d+)?)px/);
    const spacerHeight = spacer.match(/min-height:\s*(\d+(?:\.\d+)?)px/);
    expect(hintHeight).not.toBeNull();
    expect(spacerHeight).not.toBeNull();
    expect(hintHeight![1]).toBe(spacerHeight![1]);
  });

  test('a @container rule (not a viewport media query) is what reveals the spacer', () => {
    // scanBlocks' brace counter doesn't understand Sass `#{...}` interpolation (it
    // treats those braces as block delimiters too), so this one rule — the only one
    // in the file using interpolation — is asserted directly against the source
    // rather than through the block scanner.
    const containerRule = fieldScss.match(
      /@container \(min-width: [^)]*\) \{\s*\.fieldSponsorSpacer\[data-min-tracks='[^']*'\] \{\s*display: block;/
    );
    expect(containerRule).not.toBeNull();
    // No viewport-breakpoint mixin controls visibility for this selector anymore.
    const spacerBlock = extractBlock(fieldScss, '.fieldSponsorSpacer {');
    expect(spacerBlock).not.toMatch(/@include\s+(mobile|tablet)/);
  });

  test('FieldGrid is a size container, so the @container rules above have something to query', () => {
    const block = extractBlock(fieldScss, '.fieldGrid {');
    expect(block).toMatch(/container-type:\s*inline-size/);
  });
});

describe('every field that can share a row with the sponsor field declares its own threshold', () => {
  test('SponsorHintSpacer takes a required `minTracks` prop (not rendered unconditionally)', () => {
    expect(sharedFieldsTsx).toMatch(/export function SponsorHintSpacer\(\{\s*minTracks/);
    expect(sharedFieldsTsx).toMatch(/data-min-tracks=\{minTracks\}/);
  });

  test('HostField/PortField take a `labelExtra` prop (renamed from the misleading `topExtra`)', () => {
    expect(sharedFieldsTsx).not.toMatch(/topExtra/);
    expect(sharedFieldsTsx).toMatch(/export function HostField\(\{[^}]*labelExtra/);
    expect(sharedFieldsTsx).toMatch(/export function PortField\(\{[^}]*labelExtra/);
  });

  test('SectionCommon gives Host and Port the same threshold (both need track 4, where Proxy URL lands)', () => {
    const matches = [...sectionCommonTsx.matchAll(/labelExtra=\{<SponsorHintSpacer minTracks=\{(\d+)\} \/>\}/g)];
    expect(matches.length).toBe(2);
    for (const m of matches) expect(m[1]).toBe('4');
  });

  test("SectionNetwork's first FieldGrid gives every sibling of ProxyUrlField its own increasing track threshold", () => {
    // ProxyUrlField spans tracks 1-2 and renders the real sponsor hint via its own
    // labelExtra. Every other field in this FieldGrid occupies one more track than
    // the previous sibling, in DOM order, so each needs a strictly larger minTracks
    // than the one before it — never the same number, never unconditional.
    const fieldsNeedingSlot = [
      'requestRetry',
      'maxRetryCredentials',
      'maxRetryInterval',
      'authAutoRefreshWorkers',
      'routingStrategy',
      'disableImageGeneration',
      'gptImage2BaseModel',
      'routingSessionAffinityTTL',
    ];
    let previousThreshold = 2; // ProxyUrlField occupies tracks 1-2.
    for (const fieldId of fieldsNeedingSlot) {
      const anchorIdx = sectionNetworkTsx.indexOf(`fieldId="${fieldId}"`);
      expect(anchorIdx).toBeGreaterThan(-1);
      const nextAnchorIdx = sectionNetworkTsx.indexOf('FieldAnchor fieldId', anchorIdx + 1);
      const fieldSlice = sectionNetworkTsx.slice(
        anchorIdx,
        nextAnchorIdx === -1 ? anchorIdx + 600 : nextAnchorIdx
      );
      const match = fieldSlice.match(/<SponsorHintSpacer minTracks=\{(\d+)\} \/>/);
      expect(match).not.toBeNull();
      const threshold = Number(match![1]);
      expect(threshold).toBeGreaterThan(previousThreshold);
      previousThreshold = threshold;
    }
  });

  test('FieldShell supports `labelExtra` so Select-based fields (routingStrategy, disableImageGeneration) can take the same slot', () => {
    const primitives = readFileSync(
      new URL('../src/features/config/components/fields/FieldPrimitives.tsx', import.meta.url),
      'utf8'
    );
    const fieldShellBlock = primitives.slice(primitives.indexOf('export function FieldShell'));
    expect(fieldShellBlock).toMatch(/labelExtra\?:\s*ReactNode/);
    expect(fieldShellBlock).toMatch(/\{labelExtra\}/);
  });
});
