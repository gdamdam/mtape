// mtape — pure clip geometry.
//
// Every function is a deterministic transform on a Clip and returns a NEW clip
// (or clips); inputs are never mutated. Placement math lives here so the UI,
// undo stack and engine all agree on what a drag/trim/split means.

import type { Clip, ClipFades } from '../audio/contracts'

/** Smallest sounding length we allow a clip to shrink to. A clip of exactly
 *  zero length is meaningless and would make trim/split math degenerate, so we
 *  keep a hair of duration instead of ever hitting 0. */
const MIN_DURATION_SEC = 1e-6

/** Clamp helper local to this module (contracts' clampNumber also coerces
 *  non-numbers, which we don't need for already-typed clip fields). */
function clamp(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}

/** Timeline position one sample-hair past the clip's out-point. */
export function clipEndSec(clip: Clip): number {
  return clip.startSec + clip.durationSec
}

/** Shift the clip along the timeline; a clip can never start before 0. */
export function moveClip(clip: Clip, deltaSec: number): Clip {
  return { ...clip, startSec: Math.max(0, clip.startSec + deltaSec) }
}

/** Place the clip's in-point at an absolute timeline position (>= 0). */
export function setClipStart(clip: Clip, startSec: number): Clip {
  return { ...clip, startSec: Math.max(0, startSec) }
}

/**
 * Drag the in-handle. The source is locked to the timeline: moving the start by
 * δ walks the source offset by the same δ and shrinks the sounding duration by
 * δ, so the audible material under the moved edge stays put. δ is clamped so the
 * offset never goes negative and the duration never drops below MIN_DURATION_SEC
 * (which also prevents the new start from reaching/passing the clip end). δ is
 * also floored so the new start never crosses 0, upholding the same startSec >= 0
 * invariant that moveClip/setClipStart enforce — otherwise the persistence
 * sanitizer would later clamp startSec without compensating offset/duration and
 * shift the audio.
 */
export function trimIn(clip: Clip, newStartSec: number): Clip {
  const rawDelta = newStartSec - clip.startSec
  // Left bound: offsetSec + δ >= 0 AND startSec + δ >= 0. Right bound:
  // durationSec - δ >= epsilon.
  const minDelta = Math.max(-clip.offsetSec, -clip.startSec)
  const delta = clamp(rawDelta, minDelta, clip.durationSec - MIN_DURATION_SEC)
  return {
    ...clip,
    startSec: clip.startSec + delta,
    offsetSec: clip.offsetSec + delta,
    durationSec: clip.durationSec - delta,
  }
}

/**
 * Drag the out-handle to an absolute end position. Duration cannot collapse to
 * zero. Source availability (an upper cap) is the caller's concern — the clip
 * model carries no source length — so we only enforce the lower bound.
 */
export function trimOut(clip: Clip, newEndSec: number): Clip {
  return { ...clip, durationSec: Math.max(MIN_DURATION_SEC, newEndSec - clip.startSec) }
}

/**
 * Split at a timeline position into two source-locked clips. A = [start, atSec]
 * keeps the in-fade and loses its out-fade; B = [atSec, end] advances its source
 * offset and keeps the out-fade, losing its in-fade. atSec is clamped strictly
 * inside the clip so both halves keep positive duration.
 */
export function splitClip(clip: Clip, atSec: number, newIdA: string, newIdB: string): [Clip, Clip] {
  const end = clipEndSec(clip)
  const at = clamp(atSec, clip.startSec + MIN_DURATION_SEC, end - MIN_DURATION_SEC)
  const aDuration = at - clip.startSec

  const a: Clip = {
    ...clip,
    id: newIdA,
    durationSec: aDuration,
    fades: { inSec: clip.fades.inSec, outSec: 0 } satisfies ClipFades,
  }
  const b: Clip = {
    ...clip,
    id: newIdB,
    startSec: at,
    offsetSec: clip.offsetSec + aDuration,
    durationSec: end - at,
    fades: { inSec: 0, outSec: clip.fades.outSec } satisfies ClipFades,
  }
  return [a, b]
}

/** Copy a clip under a new id. By default the copy lands right after the
 *  original; pass atSec to drop it at an explicit timeline position. */
export function duplicateClip(clip: Clip, newId: string, atSec?: number): Clip {
  return {
    ...clip,
    id: newId,
    startSec: atSec ?? clipEndSec(clip),
    fades: { ...clip.fades },
  }
}

/** Round a time to the nearest grid line. A non-positive grid means "no grid". */
export function snapSecToGrid(sec: number, gridSec: number): number {
  if (gridSec <= 0) return sec
  return Math.round(sec / gridSec) * gridSec
}

/**
 * Linear fade-envelope multiplier in [0,1] at a position measured from the clip
 * start. Ramps 0->1 across the in-fade and 1->0 across the out-fade, is 1 in the
 * sustain, and 0 outside the clip. When the two fades overlap we take the min of
 * the two ramps, so the envelope stays continuous and never exceeds either fade.
 */
export function fadeGainAt(clip: Clip, clipLocalSec: number): number {
  const { durationSec } = clip
  if (durationSec <= 0) return 0
  if (clipLocalSec < 0 || clipLocalSec > durationSec) return 0

  const inSec = clip.fades.inSec
  const outSec = clip.fades.outSec
  const inGain = inSec > 0 ? clamp(clipLocalSec / inSec, 0, 1) : 1
  const outGain = outSec > 0 ? clamp((durationSec - clipLocalSec) / outSec, 0, 1) : 1
  return Math.min(inGain, outGain)
}
