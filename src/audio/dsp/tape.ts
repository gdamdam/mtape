// mtape — pure tape-character DSP primitives.
//
// This is the tool's identity feature: subtle, default-OFF tape colour. Every
// function here is PURE and deterministic — no DOM, no Web Audio, no clock, no
// randomness. Time is always an explicit parameter so the same input yields the
// same output on every host (worklet, offline render, tests).
//
// Units are documented per-function. "amount" everywhere is the normalized
// 0..1 tape-character control from `TapeCharacter` (saturation / wowFlutter).

import { clampNumber, TAPE_AMOUNT_MAX, TAPE_AMOUNT_MIN } from '../contracts'

// --------------------------------------------------------------------------
// Soft saturation
// --------------------------------------------------------------------------

/**
 * tanh drive at amount=1. `drive = amount * SATURATION_DRIVE`, so the knee
 * sharpens as amount rises. Kept modest to stay tasteful; default-off anyway.
 */
export const SATURATION_DRIVE = 4

/**
 * Tape-style soft saturation of a single sample.
 *
 * @param x       input sample (nominally |x| <= 1 full-scale, but any finite value is safe)
 * @param amount  drive, 0..1. 0 => exact bypass (passthrough).
 * @returns saturated sample.
 *
 * Curve: `tanh(drive * x) / tanh(drive)` with `drive = amount * SATURATION_DRIVE`
 * — the same continuous, full-scale-preserving normalization as `softClipDrive`
 * in dynamics.ts (mirrored here, not shared, to keep this module dependency-free).
 * Properties:
 *  - continuous in amount at 0: as amount -> 0+, drive -> 0 and the curve -> x
 *    (identity), so leaving the knob's zero introduces no jump.
 *  - full-scale preserved: f(±1) = ±1 for every amount (normalizing by
 *    `tanh(drive)` pins the rails), so peaks don't dip when the knob engages.
 *  - odd-symmetric: f(-x) = -f(x) (tanh is odd).
 *  - monotonic increasing in x (tanh is, drive > 0).
 *  - on nominal input |x| <= 1, |f(x)| <= 1 (never exceeds full scale); finite
 *    for all x.
 *  - low-level boost (the tape "fullness"): f'(0) = drive/tanh(drive) >= 1,
 *    rising with amount, so quiet signals lift relative to peaks.
 *
 * The amount==0 fast path is an exact bypass (and avoids the 0/0 at drive=0).
 */
export function softSaturate(x: number, amount: number): number {
  if (!Number.isFinite(x)) return 0
  const a = clampNumber(amount, TAPE_AMOUNT_MIN, TAPE_AMOUNT_MAX, 0)
  if (a <= 0) return x // true bypass — identity, passthrough
  const drive = a * SATURATION_DRIVE
  return Math.tanh(drive * x) / Math.tanh(drive)
}

// --------------------------------------------------------------------------
// Wow & flutter
// --------------------------------------------------------------------------

/** Options for the wow/flutter generator. Sensible tape-like defaults apply. */
export interface WowFlutterOptions {
  /** Slow "wow" LFO frequency, Hz. Tape decks wander around ~0.5–1 Hz. */
  wowHz?: number
  /** Faster "flutter" frequency, Hz. Typically ~6–10 Hz. */
  flutterHz?: number
  /** Peak modulation depth in seconds at amount=1 (and unit weights). */
  maxDepthSec?: number
  /** Relative weight of the wow component. Defaults sum to 1 so the bound holds. */
  wowWeight?: number
  /** Relative weight of the flutter component. */
  flutterWeight?: number
}

export const WOW_HZ_DEFAULT = 0.6
export const FLUTTER_HZ_DEFAULT = 7
/** ~5 ms peak drift at full amount — enough to hear, small enough to stay musical. */
export const WOW_FLUTTER_MAX_DEPTH_SEC = 0.005
const WOW_WEIGHT_DEFAULT = 0.7
const FLUTTER_WEIGHT_DEFAULT = 0.3

const TWO_PI = Math.PI * 2

/**
 * Deterministic wow+flutter modulation offset, in SECONDS, for a given time.
 *
 * This is a pure function of time — combining a slow "wow" sine and a faster
 * "flutter" sine at fixed frequencies and phases (no randomness). The returned
 * value is a delay/pitch offset to feed a varispeed read via `interpolateSample`.
 *
 * @param timeSec  absolute time in seconds.
 * @param amount   depth, 0..1. 0 => returns exactly 0.
 * @returns offset in seconds, bounded by
 *          `amount * maxDepthSec * (wowWeight + flutterWeight)`.
 *          With the default unit-sum weights this is `amount * maxDepthSec`.
 *
 * Continuity: a sum of sines, so continuous and smooth in time. Periodicity: the
 * wow component repeats every `1/wowHz`; the flutter every `1/flutterHz`.
 */
export function wowFlutterOffset(timeSec: number, amount: number, opts: WowFlutterOptions = {}): number {
  const a = clampNumber(amount, TAPE_AMOUNT_MIN, TAPE_AMOUNT_MAX, 0)
  if (a <= 0 || !Number.isFinite(timeSec)) return 0

  const wowHz = opts.wowHz ?? WOW_HZ_DEFAULT
  const flutterHz = opts.flutterHz ?? FLUTTER_HZ_DEFAULT
  const maxDepthSec = opts.maxDepthSec ?? WOW_FLUTTER_MAX_DEPTH_SEC
  const wowWeight = opts.wowWeight ?? WOW_WEIGHT_DEFAULT
  const flutterWeight = opts.flutterWeight ?? FLUTTER_WEIGHT_DEFAULT

  const wow = wowWeight * Math.sin(TWO_PI * wowHz * timeSec)
  const flutter = flutterWeight * Math.sin(TWO_PI * flutterHz * timeSec)
  return a * maxDepthSec * (wow + flutter)
}

// --------------------------------------------------------------------------
// Fractional-position sample reads (backs varispeed + wow/flutter delay reads)
// --------------------------------------------------------------------------

/**
 * Linear-interpolated read of `buffer` at a fractional `position` (in samples).
 *
 * Positions outside `[0, length-1]` are clamped to the nearest edge sample; an
 * empty buffer (or a non-finite position) reads as 0. This is the workhorse for
 * varispeed resampling and for reading a wow/flutter-modulated delay line.
 *
 * @param buffer   source samples.
 * @param position fractional sample index.
 * @returns interpolated sample value.
 */
export function interpolateSample(buffer: Float32Array, position: number): number {
  const n = buffer.length
  if (n === 0 || !Number.isFinite(position)) return 0
  if (position <= 0) return buffer[0]
  if (position >= n - 1) return buffer[n - 1]
  const i = Math.floor(position)
  const frac = position - i
  return buffer[i] * (1 - frac) + buffer[i + 1] * frac
}

/**
 * Catmull-Rom cubic-interpolated read of `buffer` at a fractional `position`.
 *
 * Smoother than linear (continuous first derivative), which matters for slow
 * varispeed sweeps where linear interpolation's kinks alias audibly. Edge
 * neighbours are clamped, so the ends degrade gracefully to lower-order behaviour.
 * Same clamping/empty-buffer contract as `interpolateSample`.
 */
export function interpolateSampleCubic(buffer: Float32Array, position: number): number {
  const n = buffer.length
  if (n === 0 || !Number.isFinite(position)) return 0
  if (position <= 0) return buffer[0]
  if (position >= n - 1) return buffer[n - 1]
  const i = Math.floor(position)
  const frac = position - i
  // Clamp the 4-point stencil to valid indices at the buffer edges.
  const p0 = buffer[i - 1 < 0 ? 0 : i - 1]
  const p1 = buffer[i]
  const p2 = buffer[i + 1]
  const p3 = buffer[i + 2 > n - 1 ? n - 1 : i + 2]
  const a0 = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3
  const a1 = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3
  const a2 = -0.5 * p0 + 0.5 * p2
  return ((a0 * frac + a1) * frac + a2) * frac + p1
}
