type ScrollStrip = Pick<HTMLElement, 'scrollWidth' | 'clientWidth' | 'scrollLeft'>;

/**
 * Decides which edge mask-fades should be visible for a horizontally scrollable
 * tab strip. A fade is only shown on the side that actually has more content to
 * scroll toward; at scrollLeft 0 (or past the max, allowing for subpixel rounding)
 * that side's fade — and the focus ring it would otherwise dim — stays off.
 */
export function computeConfigTabsFade(strip: ScrollStrip): {
  fadeStart: boolean;
  fadeEnd: boolean;
} {
  const maxScroll = strip.scrollWidth - strip.clientWidth;
  if (maxScroll <= 1) return { fadeStart: false, fadeEnd: false };
  const EPSILON = 1;
  return {
    fadeStart: strip.scrollLeft > EPSILON,
    fadeEnd: strip.scrollLeft < maxScroll - EPSILON,
  };
}
