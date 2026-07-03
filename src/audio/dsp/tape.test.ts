import { describe, expect, it } from 'vitest'
import {
  FLUTTER_HZ_DEFAULT,
  WOW_FLUTTER_MAX_DEPTH_SEC,
  WOW_HZ_DEFAULT,
  interpolateSample,
  interpolateSampleCubic,
  softSaturate,
  wowFlutterOffset,
} from './tape'

// Dense linear sweep over a range, used to check monotonicity/symmetry.
function sweep(min: number, max: number, steps: number): number[] {
  const out: number[] = []
  for (let k = 0; k <= steps; k++) out.push(min + ((max - min) * k) / steps)
  return out
}

describe('softSaturate', () => {
  it('is a true bypass (identity) at amount 0 across [-1, 1]', () => {
    for (const x of sweep(-1, 1, 40)) {
      expect(softSaturate(x, 0)).toBeCloseTo(x, 12)
    }
  })

  it('never exceeds full scale on nominal input (|x| <= 1) at every engaged amount', () => {
    // The tanh(drive*x)/tanh(drive) curve pins the rails, so a full-scale input
    // maps to at most full-scale output — peaks are held, not overshot.
    for (const amount of [0.05, 0.25, 0.5, 0.75, 1]) {
      for (const x of sweep(-1, 1, 200)) {
        expect(Math.abs(softSaturate(x, amount))).toBeLessThanOrEqual(1 + 1e-9)
      }
    }
  })

  it('stays finite for large |x| at every engaged amount', () => {
    for (const amount of [0.05, 0.25, 0.5, 0.75, 1]) {
      for (const x of sweep(-10, 10, 200)) {
        expect(Number.isFinite(softSaturate(x, amount))).toBe(true)
      }
    }
  })

  it('is odd-symmetric: f(-x) = -f(x)', () => {
    for (const amount of [0, 0.3, 0.7, 1]) {
      for (const x of sweep(0, 8, 50)) {
        expect(softSaturate(-x, amount)).toBeCloseTo(-softSaturate(x, amount), 12)
      }
    }
  })

  it('is monotonically non-decreasing along a sweep', () => {
    // Non-decreasing (not strictly increasing): at high amounts the curve reaches
    // its asymptote where adjacent tanh values are numerically equal — that flat
    // tail IS the saturation, so equality there is correct.
    for (const amount of [0, 0.2, 0.6, 1]) {
      let prev = softSaturate(-6, amount)
      for (const x of sweep(-6, 6, 300).slice(1)) {
        const y = softSaturate(x, amount)
        expect(y).toBeGreaterThanOrEqual(prev)
        prev = y
      }
    }
    // Strict monotonicity still holds across the active (unsaturated) region.
    for (const amount of [0.2, 0.6, 1]) {
      let prev = softSaturate(-0.5, amount)
      for (const x of sweep(-0.5, 0.5, 100).slice(1)) {
        const y = softSaturate(x, amount)
        expect(y).toBeGreaterThan(prev)
        prev = y
      }
    }
  })

  it('boosts low level (origin slope >= 1, rising with amount) — the tape "fullness"', () => {
    const dx = 1e-4
    const slopeAt = (amount: number) =>
      (softSaturate(dx, amount) - softSaturate(-dx, amount)) / (2 * dx)
    // amount 0 is exact bypass: unity slope.
    expect(slopeAt(0)).toBeCloseTo(1, 3)
    // Engaged amounts lift quiet signals (slope > 1), monotonically with amount.
    let prev = slopeAt(0)
    for (const amount of [0.3, 0.7, 1]) {
      const slope = slopeAt(amount)
      expect(slope).toBeGreaterThan(1)
      expect(slope).toBeGreaterThan(prev)
      prev = slope
    }
  })

  it('approaches identity as amount -> 0+ (continuous with the amount-0 bypass) [L2]', () => {
    // The old curve jumped (e.g. x=1 snapping 1.0 -> 0.762) the instant the knob
    // left 0; the normalized curve tends to identity as drive -> 0.
    for (const x of sweep(-1, 1, 40)) {
      expect(softSaturate(x, 1e-4)).toBeCloseTo(x, 3)
    }
  })

  it('preserves full-scale peaks (f(±1) = ±1) at every engaged amount [L2]', () => {
    // Peaks must not dip when saturation engages (old curve dropped 0.5 -> 0.197).
    for (const amount of [0.05, 0.25, 0.5, 0.75, 1]) {
      expect(softSaturate(1, amount)).toBeCloseTo(1, 6)
      expect(softSaturate(-1, amount)).toBeCloseTo(-1, 6)
    }
  })

  it('compresses peaks more as amount rises', () => {
    // A loud peak (|x| = 2) should be pulled down further at higher amounts.
    const peak = 2
    const amounts = [0.1, 0.3, 0.6, 1]
    let prev = softSaturate(peak, amounts[0])
    for (const amount of amounts.slice(1)) {
      const y = softSaturate(peak, amount)
      expect(y).toBeLessThan(prev)
      prev = y
    }
    // And every engaged amount reduces the peak below its input level.
    for (const amount of amounts) {
      expect(softSaturate(peak, amount)).toBeLessThan(peak)
    }
  })

  it('coerces non-finite input to 0', () => {
    expect(softSaturate(NaN, 0.5)).toBe(0)
    expect(softSaturate(Infinity, 0.5)).toBe(0)
  })
})

describe('wowFlutterOffset', () => {
  it('is exactly 0 at amount 0 for all times', () => {
    for (const t of sweep(0, 10, 50)) {
      expect(wowFlutterOffset(t, 0)).toBe(0)
    }
  })

  it('is bounded by amount * maxDepth with the default unit-sum weights', () => {
    for (const amount of [0.25, 0.5, 1]) {
      const bound = amount * WOW_FLUTTER_MAX_DEPTH_SEC
      for (const t of sweep(0, 20, 2000)) {
        // tiny epsilon guards against float rounding at the extrema
        expect(Math.abs(wowFlutterOffset(t, amount))).toBeLessThanOrEqual(bound + 1e-12)
      }
    }
  })

  it('scales linearly with amount', () => {
    const t = 0.37 // arbitrary non-zero phase
    const base = wowFlutterOffset(t, 1)
    expect(wowFlutterOffset(t, 0.5)).toBeCloseTo(base * 0.5, 12)
    expect(wowFlutterOffset(t, 0.25)).toBeCloseTo(base * 0.25, 12)
  })

  it('is continuous in time (small dt => small change)', () => {
    const dt = 1e-5
    for (const t of sweep(0, 5, 200)) {
      const delta = Math.abs(wowFlutterOffset(t + dt, 1) - wowFlutterOffset(t, 1))
      expect(delta).toBeLessThan(1e-3)
    }
  })

  it('the wow component is periodic with period 1/wowHz', () => {
    const period = 1 / WOW_HZ_DEFAULT
    const opts = { flutterWeight: 0 } // isolate the slow wow sine
    for (const t of sweep(0, 3, 30)) {
      expect(wowFlutterOffset(t + period, 1, opts)).toBeCloseTo(wowFlutterOffset(t, 1, opts), 10)
    }
  })

  it('the flutter component is periodic with period 1/flutterHz', () => {
    const period = 1 / FLUTTER_HZ_DEFAULT
    const opts = { wowWeight: 0 } // isolate the fast flutter sine
    for (const t of sweep(0, 3, 30)) {
      expect(wowFlutterOffset(t + period, 1, opts)).toBeCloseTo(wowFlutterOffset(t, 1, opts), 10)
    }
  })

  it('actually oscillates through positive and negative values', () => {
    let sawPos = false
    let sawNeg = false
    for (const t of sweep(0, 5, 500)) {
      const v = wowFlutterOffset(t, 1)
      if (v > 1e-6) sawPos = true
      if (v < -1e-6) sawNeg = true
    }
    expect(sawPos && sawNeg).toBe(true)
  })
})

describe('interpolateSample', () => {
  const buf = new Float32Array([0, 10, 20, 30])

  it('is exact at integer positions', () => {
    expect(interpolateSample(buf, 0)).toBeCloseTo(0)
    expect(interpolateSample(buf, 1)).toBeCloseTo(10)
    expect(interpolateSample(buf, 2)).toBeCloseTo(20)
    expect(interpolateSample(buf, 3)).toBeCloseTo(30)
  })

  it('returns the average at the midpoint between two samples', () => {
    expect(interpolateSample(buf, 0.5)).toBeCloseTo(5)
    expect(interpolateSample(buf, 1.5)).toBeCloseTo(15)
    expect(interpolateSample(buf, 2.5)).toBeCloseTo(25)
  })

  it('interpolates arbitrary fractions linearly', () => {
    expect(interpolateSample(buf, 0.25)).toBeCloseTo(2.5)
    expect(interpolateSample(buf, 1.75)).toBeCloseTo(17.5)
  })

  it('clamps positions outside [0, length-1] to the edge samples', () => {
    expect(interpolateSample(buf, -5)).toBeCloseTo(0)
    expect(interpolateSample(buf, -0.001)).toBeCloseTo(0)
    expect(interpolateSample(buf, 3)).toBeCloseTo(30)
    expect(interpolateSample(buf, 100)).toBeCloseTo(30)
  })

  it('reads an empty buffer or non-finite position as 0', () => {
    expect(interpolateSample(new Float32Array([]), 2)).toBe(0)
    expect(interpolateSample(buf, NaN)).toBe(0)
    expect(interpolateSample(buf, Infinity)).toBe(0)
  })
})

describe('interpolateSampleCubic', () => {
  const buf = new Float32Array([0, 10, 20, 30, 40])

  it('is exact at integer positions', () => {
    for (let i = 0; i < buf.length; i++) {
      expect(interpolateSampleCubic(buf, i)).toBeCloseTo(buf[i])
    }
  })

  it('reproduces a linear ramp exactly (Catmull-Rom preserves linears)', () => {
    // On a perfectly linear signal the cubic read must equal linear interpolation.
    expect(interpolateSampleCubic(buf, 1.5)).toBeCloseTo(15)
    expect(interpolateSampleCubic(buf, 2.25)).toBeCloseTo(22.5)
  })

  it('clamps edges and empty/non-finite input like the linear variant', () => {
    expect(interpolateSampleCubic(buf, -1)).toBeCloseTo(0)
    expect(interpolateSampleCubic(buf, 999)).toBeCloseTo(40)
    expect(interpolateSampleCubic(new Float32Array([]), 1)).toBe(0)
    expect(interpolateSampleCubic(buf, NaN)).toBe(0)
  })
})
