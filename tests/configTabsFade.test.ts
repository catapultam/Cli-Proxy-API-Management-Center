import { describe, expect, test } from 'bun:test';
import { computeConfigTabsFade } from '@/features/config/components/configTabsFade';

describe('computeConfigTabsFade', () => {
  test('no overflow: neither edge fades', () => {
    expect(computeConfigTabsFade({ scrollWidth: 400, clientWidth: 400, scrollLeft: 0 })).toEqual({
      fadeStart: false,
      fadeEnd: false,
    });
  });

  test('at scrollLeft 0 with overflow: only the end fades', () => {
    expect(computeConfigTabsFade({ scrollWidth: 800, clientWidth: 400, scrollLeft: 0 })).toEqual({
      fadeStart: false,
      fadeEnd: true,
    });
  });

  test('scrolled to the max: only the start fades', () => {
    expect(computeConfigTabsFade({ scrollWidth: 800, clientWidth: 400, scrollLeft: 400 })).toEqual({
      fadeStart: true,
      fadeEnd: false,
    });
  });

  test('scrolled to the middle: both edges fade', () => {
    expect(computeConfigTabsFade({ scrollWidth: 800, clientWidth: 400, scrollLeft: 200 })).toEqual({
      fadeStart: true,
      fadeEnd: true,
    });
  });

  test('tolerates subpixel rounding at both ends', () => {
    expect(computeConfigTabsFade({ scrollWidth: 800, clientWidth: 400, scrollLeft: 0.4 })).toEqual({
      fadeStart: false,
      fadeEnd: true,
    });
    expect(
      computeConfigTabsFade({ scrollWidth: 800, clientWidth: 400, scrollLeft: 399.7 })
    ).toEqual({
      fadeStart: true,
      fadeEnd: false,
    });
  });
});
