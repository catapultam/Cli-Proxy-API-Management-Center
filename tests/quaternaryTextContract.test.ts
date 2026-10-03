/**
 * Source-contract regression test: `--text-quaternary` usage stays scoped to
 * decoration, not real content.
 *
 * `--text-quaternary` is reserved for non-text decoration (separator dots/rules,
 * purely decorative icons, and disabled-state text). Any `color:` declaration on
 * it elsewhere is almost certainly real data/label text rendered under the
 * 4.5:1 contrast floor that `--text-tertiary` clears and `--text-quaternary`
 * does not. This scans every `.scss` file (via `scanBlocks`, a brace-matching
 * scanner) so a new offender fails immediately instead of waiting for the next
 * manual review pass.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { listScssFiles, scanBlocks } from './helpers/cssTokens';

const readSource = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/**
 * Each entry is a specific selector in a specific file, justified below. Adding
 * to this list should be rare and should always be accompanied by a reason that
 * is true of the selector's actual rendered content (checked against the
 * component's .tsx usage, not assumed from the class name).
 */
const ALLOWLIST: Record<string, { selectors: string[]; reason: string }> = {
  'src/features/authFiles/components/AuthFileCard.module.scss': {
    selectors: ['.metaDivider'],
    reason:
      'Separator glyph between meta items; rendered with aria-hidden="true" in AuthFileCard.tsx.',
  },
  'src/features/authFiles/components/AuthFileQuota.module.scss': {
    selectors: ['&:disabled', '&::before'],
    reason:
      '&:disabled is the disabled-state colour for .actionButton (explicitly allowed); ' +
      '&::before on .quotaResetRelative is the "·" separator glyph, not data text.',
  },
  'src/features/authFiles/components/VaultHeader.module.scss': {
    selectors: ['.metaDot'],
    reason:
      'Separator glyph between meta items; rendered with aria-hidden="true" in VaultHeader.tsx.',
  },
  'src/features/config/components/ConfigHeader.module.scss': {
    selectors: ['.metaDot'],
    reason:
      'Separator glyph between meta items; rendered with aria-hidden="true" in ConfigHeader.tsx.',
  },
  'src/features/quota/components/QuotaBody.module.scss': {
    selectors: ['&::before'],
    reason: '&::before on .quotaResetRelative is the "·" separator glyph, not data text.',
  },
  'src/features/quota/components/QuotaHeader.module.scss': {
    selectors: ['.metaDot'],
    reason:
      'Separator glyph between meta items; rendered with aria-hidden="true" in QuotaHeader.tsx.',
  },
};

describe('--text-quaternary is never used for data/label text colour', () => {
  test('every remaining color:quaternary site is on the explicit decorative allowlist', () => {
    const offenders: string[] = [];
    for (const path of listScssFiles('src')) {
      const src = readSource(path);
      const entry = ALLOWLIST[path];
      for (const block of scanBlocks(src)) {
        if (!/color\s*:\s*var\(--text-quaternary\)/.test(block.own)) continue;
        const allowedSelectors = entry?.selectors ?? [];
        const isAllowed = allowedSelectors.some((sel) => block.selector.includes(sel));
        if (!isAllowed) {
          offenders.push(`${path} :: ${block.selector}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the allowlist does not accumulate stale entries (every listed selector still exists)', () => {
    for (const [path, { selectors }] of Object.entries(ALLOWLIST)) {
      const src = readSource(path);
      for (const selector of selectors) {
        const stillPresent = scanBlocks(src).some(
          (block) =>
            block.selector.includes(selector) &&
            /color\s*:\s*var\(--text-quaternary\)/.test(block.own)
        );
        expect(stillPresent).toBe(true);
      }
    }
  });
});
