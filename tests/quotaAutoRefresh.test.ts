/**
 * Pure scheduling decisions behind the Quota page's periodic auto-refresh.
 * The hook itself (useQuotaAutoRefresh) only wires these to one setTimeout
 * plus a visibilitychange listener — the interesting behavior lives here,
 * where it can be tested without real timers.
 */

import { describe, expect, test } from 'bun:test';
import { msUntilNextRefresh, shouldAutoRefresh } from '@/features/quota/hooks/useQuotaAutoRefresh';

const MINUTE = 60_000;
const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime();

const baseInput = {
  now: NOW,
  lastRefreshAt: NOW - 5 * MINUTE,
  intervalMs: 5 * MINUTE,
  visible: true,
  busy: false,
  disabled: false,
};

describe('shouldAutoRefresh', () => {
  test('off: never fires when intervalMs is 0', () => {
    expect(shouldAutoRefresh({ ...baseInput, intervalMs: 0 })).toBe(false);
  });

  test('not yet due: elapsed time is below the interval', () => {
    expect(
      shouldAutoRefresh({ ...baseInput, lastRefreshAt: NOW - 4 * MINUTE, intervalMs: 5 * MINUTE })
    ).toBe(false);
  });

  test('due: elapsed time has reached the interval', () => {
    expect(shouldAutoRefresh(baseInput)).toBe(true);
  });

  test('due: elapsed time has exceeded the interval', () => {
    expect(shouldAutoRefresh({ ...baseInput, lastRefreshAt: NOW - 9 * MINUTE })).toBe(true);
  });

  test('busy: never fires while the file list or a batch load is in flight', () => {
    expect(shouldAutoRefresh({ ...baseInput, busy: true })).toBe(false);
  });

  test('hidden: never fires while the tab is not visible', () => {
    expect(shouldAutoRefresh({ ...baseInput, visible: false })).toBe(false);
  });

  test('disabled: never fires while controls are disabled (e.g. disconnected)', () => {
    expect(shouldAutoRefresh({ ...baseInput, disabled: true })).toBe(false);
  });

  test('visibility regained after the interval elapsed: fires immediately', () => {
    // The tab was hidden through the whole interval; it just came back.
    expect(
      shouldAutoRefresh({ ...baseInput, lastRefreshAt: NOW - 6 * MINUTE, visible: true })
    ).toBe(true);
  });

  test('visibility regained before the interval elapsed: does not fire yet', () => {
    expect(
      shouldAutoRefresh({ ...baseInput, lastRefreshAt: NOW - 2 * MINUTE, visible: true })
    ).toBe(false);
  });

  test('manual refresh resets the countdown: due right after becomes not due', () => {
    expect(shouldAutoRefresh(baseInput)).toBe(true);
    // A manual "Refresh all" bumps lastRefreshAt to now.
    expect(shouldAutoRefresh({ ...baseInput, lastRefreshAt: NOW })).toBe(false);
  });
});

describe('msUntilNextRefresh', () => {
  test('off: Infinity when intervalMs is 0 (no timer should be scheduled)', () => {
    expect(msUntilNextRefresh({ now: NOW, lastRefreshAt: NOW, intervalMs: 0 })).toBe(Infinity);
  });

  test('counts down from the last refresh, not from now', () => {
    const wait = msUntilNextRefresh({
      now: NOW,
      lastRefreshAt: NOW - 2 * MINUTE,
      intervalMs: 5 * MINUTE,
    });
    expect(wait).toBe(3 * MINUTE);
  });

  test('clamps to zero once the interval has already elapsed', () => {
    const wait = msUntilNextRefresh({
      now: NOW,
      lastRefreshAt: NOW - 9 * MINUTE,
      intervalMs: 5 * MINUTE,
    });
    expect(wait).toBe(0);
  });

  test('manual refresh resets the countdown to the full interval', () => {
    const wait = msUntilNextRefresh({ now: NOW, lastRefreshAt: NOW, intervalMs: 5 * MINUTE });
    expect(wait).toBe(5 * MINUTE);
  });
});
