/**
 * Periodic auto-refresh for the Quota page.
 *
 * Mirrors a manual "Refresh all" click, but on a timer: scheduling decisions
 * are pure functions (shouldAutoRefresh / msUntilNextRefresh) so they can be
 * unit-tested without real timers. The hook itself only wires those decisions
 * to a single setTimeout plus a visibilitychange listener — it never stacks
 * more than one pending timer, and clears everything on unmount or whenever
 * the interval changes.
 */

import { useEffect } from 'react';
import type { QuotaAutoRefreshMs } from '../constants';

export interface AutoRefreshDecisionInput {
  /** Current time, injectable for tests. */
  now: number;
  /** Timestamp (ms) of the last refresh of any kind (manual or automatic). */
  lastRefreshAt: number;
  /** Selected auto-refresh interval; 0 means "Off". */
  intervalMs: number;
  /** `document.visibilityState === 'visible'`. */
  visible: boolean;
  /** File list loading or batch quota loading is in flight. */
  busy: boolean;
  /** Controls are disabled (e.g. not connected). */
  disabled: boolean;
}

/** Whether an auto-refresh should fire right now. */
export function shouldAutoRefresh({
  now,
  lastRefreshAt,
  intervalMs,
  visible,
  busy,
  disabled,
}: AutoRefreshDecisionInput): boolean {
  if (disabled || busy || !visible) return false;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return false;
  return now - lastRefreshAt >= intervalMs;
}

export interface MsUntilNextRefreshInput {
  now: number;
  lastRefreshAt: number;
  intervalMs: number;
}

/**
 * Milliseconds until the interval elapses, measured from the last refresh.
 * Returns `Infinity` when auto-refresh is off (no timer should be scheduled).
 */
export function msUntilNextRefresh({
  now,
  lastRefreshAt,
  intervalMs,
}: MsUntilNextRefreshInput): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return Infinity;
  return Math.max(0, intervalMs - (now - lastRefreshAt));
}

export interface UseQuotaAutoRefreshOptions {
  intervalMs: QuotaAutoRefreshMs;
  /** Controls are disabled (e.g. not connected) — never auto-refresh. */
  disabled: boolean;
  /** File list loading or batch quota loading is in flight. */
  busy: boolean;
  /** Timestamp (ms) of the last refresh of any kind; reset it on manual refresh too. */
  lastRefreshAt: number;
  /** Runs the same refresh as the header's "Refresh all" button. */
  onRefresh: () => void;
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number;
}

export function useQuotaAutoRefresh({
  intervalMs,
  disabled,
  busy,
  lastRefreshAt,
  onRefresh,
  now = Date.now,
}: UseQuotaAutoRefreshOptions): void {
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    if (disabled || intervalMs <= 0) return undefined;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    // Refreshing updates lastRefreshAt, which re-runs this effect and re-arms the timer.
    // When hidden or busy, do not re-arm either: an overdue timer would re-fire at 0ms in a
    // loop. The visibilitychange listener and the `busy` dependency pick it up instead.
    const fireOrReschedule = () => {
      const visible = document.visibilityState === 'visible';
      if (!visible || busy) return;
      const due = shouldAutoRefresh({
        now: now(),
        lastRefreshAt,
        intervalMs,
        visible,
        busy,
        disabled,
      });
      if (due) onRefresh();
      else schedule();
    };

    const schedule = () => {
      clearTimer();
      const wait = msUntilNextRefresh({ now: now(), lastRefreshAt, intervalMs });
      if (!Number.isFinite(wait)) return;
      timer = setTimeout(fireOrReschedule, wait);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') fireOrReschedule();
    };

    schedule();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearTimer();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [intervalMs, disabled, busy, lastRefreshAt, onRefresh, now]);
}
