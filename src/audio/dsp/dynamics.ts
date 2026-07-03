// mtape — master soft-clip drive + brick-wall limiter. PURE: per-instance state
// only, no clock, no randomness. This is the last stage before the output bus,
// so the limiter's hard-ceiling guarantee is a safety contract, not a nicety.

import { clampNumber, DRIVE_MIN, DRIVE_MAX, LIMITER_CEILING_DB_MIN, LIMITER_CEILING_DB_MAX } from '../contracts'
import { dbToLin } from './gain'

/**
 * Odd-symmetric soft clipper. `amount` 0..1: 0 is exact passthrough, rising
 * amount adds harmonic drive (progressively harder tanh knee). Normalizing by
 * tanh(k) pins full-scale (±1) to ±1, so lower-level signals are pulled up
 * relative to peaks — the loudness/"fullness" signature of tape/tube drive.
 * Output is bounded for all real x (tanh saturates) and monotonic in x.
 */
export function softClipDrive(x: number, amount: number): number {
  const a = clampNumber(amount, DRIVE_MIN, DRIVE_MAX, 0)
  if (a === 0) return x // exact identity — no float drift on the dry path
  // Map amount to a drive gain. ~4 at full is a firm but musical knee.
  const k = a * 4
  return Math.tanh(k * x) / Math.tanh(k)
}

/** Ceiling dBFS -> linear amplitude, clamped to the limiter's contract bounds. */
export function ceilingLin(ceilingDb: number): number {
  return dbToLin(clampNumber(ceilingDb, LIMITER_CEILING_DB_MIN, LIMITER_CEILING_DB_MAX, 0))
}

export interface BrickwallLimiterOptions {
  ceilingDb: number
  sampleRate: number
  /** Gain-recovery time constant. Default 50 ms. */
  releaseMs?: number
  /** Reserved for future look-ahead smoothing; the hard ceiling holds without it. */
  lookaheadMs?: number
}

/**
 * Feed-forward peak limiter. Attack is instantaneous by construction: the gain
 * for a sample is clamped down to ceiling/|x| BEFORE that sample is scaled, so
 * the output magnitude can never exceed the ceiling — no look-ahead required.
 * Release lets the gain recover toward unity with a one-pole time constant, so
 * signals that stay under the ceiling pass through at exact unity gain.
 */
export class BrickwallLimiter {
  private ceiling: number
  private readonly releaseCoef: number
  private gain = 1

  constructor(opts: BrickwallLimiterOptions) {
    this.ceiling = ceilingLin(opts.ceilingDb)
    const releaseSec = Math.max(0, opts.releaseMs ?? 50) / 1000
    // One-pole coefficient; guard the zero-time case to avoid a divide-by-zero.
    this.releaseCoef = releaseSec > 0 ? Math.exp(-1 / (releaseSec * opts.sampleRate)) : 0
  }

  setCeiling(db: number): void {
    this.ceiling = ceilingLin(db)
  }

  process(x: number): number {
    const mag = Math.abs(x)
    // Gain that would bring this sample exactly to the ceiling (1 if already under).
    const desired = mag > this.ceiling ? this.ceiling / mag : 1
    if (desired < this.gain) {
      this.gain = desired // instant attack — guarantees no overshoot
    } else {
      // Release upward toward the (higher) desired gain.
      this.gain = desired + (this.gain - desired) * this.releaseCoef
    }
    return x * this.gain
  }

  processBlock(input: Float32Array): Float32Array {
    const out = new Float32Array(input.length)
    for (let i = 0; i < input.length; i++) out[i] = this.process(input[i])
    return out
  }

  reset(): void {
    this.gain = 1
  }
}
