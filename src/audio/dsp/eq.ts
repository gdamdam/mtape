// mtape — 3-band EQ built from RBJ biquad filters. PURE: deterministic, stateful
// only per-instance. No Web Audio; this mirrors what the worklet runs so tests
// can exercise the exact same math on the main thread.
//
// Coefficients follow the RBJ "Audio EQ Cookbook". We store them normalized
// (a0 divided out) so the difference equation drops the a0 term. Shelving bands
// use the Q form of alpha (alpha = sin(w0)/(2Q)); with the default Q this is a
// gentle, overshoot-free shelf — the S (slope) parametrization is equivalent but
// less convenient to expose as a single knob.

import { clampNumber, EQ_GAIN_DB_MIN, EQ_GAIN_DB_MAX, type ThreeBandEq } from '../contracts'

/** Normalized biquad coefficients (a0 == 1, divided out of the numerator too). */
export interface BiquadCoeffs {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/** Default filter Q. ~0.707 is Butterworth-flat: maximally flat, no resonant peak. */
const DEFAULT_Q = Math.SQRT1_2

/** Fixed band centres. Low/high are shelves, mid is a bell — the classic
 *  broadcast-console layout callers tweak via {@link ThreeBandEqProcessor}. */
export const LOW_SHELF_HZ = 120
export const MID_PEAK_HZ = 1000
export const HIGH_SHELF_HZ = 4000

/** Shared cookbook intermediates for a given centre freq / Q. */
function terms(freq: number, sampleRate: number, q: number): { w0: number; cos: number; alpha: number } {
  const w0 = (2 * Math.PI * freq) / sampleRate
  const cos = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * q)
  return { w0, cos, alpha }
}

function normalize(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): BiquadCoeffs {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

/** Peaking (bell) filter. dBgain > 0 boosts, < 0 cuts, at the centre freq. */
export function peaking(freq: number, gainDb: number, sampleRate: number, q: number = DEFAULT_Q): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40)
  const { cos, alpha } = terms(freq, sampleRate, q)
  const b0 = 1 + alpha * A
  const b1 = -2 * cos
  const b2 = 1 - alpha * A
  const a0 = 1 + alpha / A
  const a1 = -2 * cos
  const a2 = 1 - alpha / A
  return normalize(b0, b1, b2, a0, a1, a2)
}

/** Low-shelf: shifts everything below the corner by gainDb, flat above. */
export function lowShelf(freq: number, gainDb: number, sampleRate: number, q: number = DEFAULT_Q): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40)
  const { cos, alpha } = terms(freq, sampleRate, q)
  const sqrtA2 = 2 * Math.sqrt(A) * alpha
  const b0 = A * (A + 1 - (A - 1) * cos + sqrtA2)
  const b1 = 2 * A * (A - 1 - (A + 1) * cos)
  const b2 = A * (A + 1 - (A - 1) * cos - sqrtA2)
  const a0 = A + 1 + (A - 1) * cos + sqrtA2
  const a1 = -2 * (A - 1 + (A + 1) * cos)
  const a2 = A + 1 + (A - 1) * cos - sqrtA2
  return normalize(b0, b1, b2, a0, a1, a2)
}

/** High-shelf: shifts everything above the corner by gainDb, flat below. */
export function highShelf(freq: number, gainDb: number, sampleRate: number, q: number = DEFAULT_Q): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40)
  const { cos, alpha } = terms(freq, sampleRate, q)
  const sqrtA2 = 2 * Math.sqrt(A) * alpha
  const b0 = A * (A + 1 + (A - 1) * cos + sqrtA2)
  const b1 = -2 * A * (A - 1 + (A + 1) * cos)
  const b2 = A * (A + 1 + (A - 1) * cos - sqrtA2)
  const a0 = A + 1 - (A - 1) * cos + sqrtA2
  const a1 = 2 * (A - 1 - (A + 1) * cos)
  const a2 = A + 1 - (A - 1) * cos - sqrtA2
  return normalize(b0, b1, b2, a0, a1, a2)
}

/**
 * Linear magnitude of the biquad transfer function at `freq`. Evaluates
 * H(e^{jw}) on the unit circle, w = 2π·freq/sampleRate. Used to assert frequency
 * response in tests without running signal through the filter.
 */
export function magnitudeAt(coeffs: BiquadCoeffs, freq: number, sampleRate: number): number {
  const w = (2 * Math.PI * freq) / sampleRate
  const cos1 = Math.cos(w)
  const sin1 = Math.sin(w)
  const cos2 = Math.cos(2 * w)
  const sin2 = Math.sin(2 * w)
  const numRe = coeffs.b0 + coeffs.b1 * cos1 + coeffs.b2 * cos2
  const numIm = -(coeffs.b1 * sin1 + coeffs.b2 * sin2)
  const denRe = 1 + coeffs.a1 * cos1 + coeffs.a2 * cos2
  const denIm = -(coeffs.a1 * sin1 + coeffs.a2 * sin2)
  const num = Math.hypot(numRe, numIm)
  const den = Math.hypot(denRe, denIm)
  return den === 0 ? Infinity : num / den
}

/** A single stateful biquad section, Direct Form I. Pure math, one instance
 *  owns its own delay memory — never share an instance across signal chains. */
export class Biquad {
  private c: BiquadCoeffs
  private x1 = 0
  private x2 = 0
  private y1 = 0
  private y2 = 0

  constructor(coeffs: BiquadCoeffs) {
    this.c = coeffs
  }

  /** Swap coefficients without clearing state — enables click-free param sweeps. */
  setCoeffs(coeffs: BiquadCoeffs): void {
    this.c = coeffs
  }

  process(x: number): number {
    const { b0, b1, b2, a1, a2 } = this.c
    let y = b0 * x + b1 * this.x1 + b2 * this.x2 - a1 * this.y1 - a2 * this.y2
    // Flush the output before it re-enters the feedback state: a non-finite value
    // (from a corrupt input) must not permanently poison the filter, and a
    // non-flat band decaying into silence would otherwise drive the feedback
    // registers into the denormal range — an audio-thread CPU spike. The flushed
    // value is what we store, so y1/y2 never carry NaN/denormals.
    if (!Number.isFinite(y)) y = 0
    else if (y < 1e-25 && y > -1e-25) y = 0
    this.x2 = this.x1
    this.x1 = x
    this.y2 = this.y1
    this.y1 = y
    return y
  }

  reset(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0
  }
}

/** Clamp a band's dB to the contract bounds before it reaches the math. */
function clampBand(db: number): number {
  return clampNumber(db, EQ_GAIN_DB_MIN, EQ_GAIN_DB_MAX, 0)
}

/**
 * Three cascaded biquads: low-shelf → mid-bell → high-shelf. One instance per
 * mono channel. `setParams` recomputes coefficients in place, leaving delay
 * memory intact so live EQ tweaks don't click.
 */
export class ThreeBandEqProcessor {
  private low: Biquad
  private mid: Biquad
  private high: Biquad

  constructor(
    eq: ThreeBandEq,
    private readonly sampleRate: number,
  ) {
    this.low = new Biquad(lowShelf(LOW_SHELF_HZ, clampBand(eq.lowDb), sampleRate))
    this.mid = new Biquad(peaking(MID_PEAK_HZ, clampBand(eq.midDb), sampleRate))
    this.high = new Biquad(highShelf(HIGH_SHELF_HZ, clampBand(eq.highDb), sampleRate))
  }

  setParams(eq: ThreeBandEq): void {
    this.low.setCoeffs(lowShelf(LOW_SHELF_HZ, clampBand(eq.lowDb), this.sampleRate))
    this.mid.setCoeffs(peaking(MID_PEAK_HZ, clampBand(eq.midDb), this.sampleRate))
    this.high.setCoeffs(highShelf(HIGH_SHELF_HZ, clampBand(eq.highDb), this.sampleRate))
  }

  process(x: number): number {
    return this.high.process(this.mid.process(this.low.process(x)))
  }

  reset(): void {
    this.low.reset()
    this.mid.reset()
    this.high.reset()
  }
}
