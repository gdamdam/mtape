// mtape — gain & pan math. PURE: deterministic functions of their inputs.
//
// All amplitude conversions funnel through here so the worklet, meters, and UI
// agree on a single decibel convention. -60 dB is the shared mute floor: below
// it we snap to true zero to avoid denormal-ridden "almost silent" signals.

import { clampNumber, GAIN_DB_MIN, GAIN_DB_MAX, PAN_MIN, PAN_MAX } from '../contracts'

/** Mute floor in dB. At or below this, gain is treated as absolute silence. */
export const SILENCE_DB = -60

/** dB -> linear amplitude. At/below the mute floor, collapse to exact zero. */
export function dbToLin(db: number): number {
  if (db <= SILENCE_DB) return 0
  return Math.pow(10, db / 20)
}

/** Linear amplitude -> dB. Non-positive input, or a result under the floor,
 *  clamps to SILENCE_DB so callers never see -Infinity. */
export function linToDb(lin: number): number {
  if (lin <= 0) return SILENCE_DB
  const db = 20 * Math.log10(lin)
  return db < SILENCE_DB ? SILENCE_DB : db
}

export interface StereoGain {
  left: number
  right: number
}

/**
 * Equal-power (constant-power) pan law. pan in [-1, 1] maps to an angle in
 * [0, π/2]; left = cos, right = sin keeps left² + right² == 1 across the sweep,
 * so a signal panned hard-anywhere holds constant perceived loudness. Center
 * (pan 0) sits at cos(π/4) == sin(π/4) ≈ 0.70711 on both channels.
 */
export function panGains(pan: number): StereoGain {
  const p = clampNumber(pan, PAN_MIN, PAN_MAX, 0)
  const angle = ((p + 1) / 2) * (Math.PI / 2)
  return { left: Math.cos(angle), right: Math.sin(angle) }
}

/** Track/master fader dB -> linear, clamped to the contract's dB bounds first. */
export function trackGainLin(gainDb: number): number {
  return dbToLin(clampNumber(gainDb, GAIN_DB_MIN, GAIN_DB_MAX, 0))
}
