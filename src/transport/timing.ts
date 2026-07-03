// mtape — musical-time <-> seconds conversions for the transport.
//
// PURE: deterministic functions of tempo + time signature; no clock, no DOM.
// A "beat" is one denominator-note (the 4/8 factor rescales from quarter-notes),
// so 6/8 has six eighth-note beats per bar, not two dotted-quarter beats.

import type { TimeSignature } from '../audio/contracts'

/** Ticks per beat — MIDI-style PPQ resolution used for sub-beat positions. */
export const TICKS_PER_BEAT = 960

export function secondsPerBeat(tempo: number, ts: TimeSignature): number {
  // (60/tempo) is one quarter-note; (4/denominator) rescales to the beat unit.
  return (60 / tempo) * (4 / ts.denominator)
}

export function secondsPerBar(tempo: number, ts: TimeSignature): number {
  return secondsPerBeat(tempo, ts) * ts.numerator
}

export function secToBeats(sec: number, tempo: number, ts: TimeSignature): number {
  return sec / secondsPerBeat(tempo, ts)
}

export function beatsToSec(beats: number, tempo: number, ts: TimeSignature): number {
  return beats * secondsPerBeat(tempo, ts)
}

export function secToBars(sec: number, tempo: number, ts: TimeSignature): number {
  return sec / secondsPerBar(tempo, ts)
}

export interface BarsBeats {
  bar: number
  beat: number
  ticks: number
}

export function secToBarsBeats(sec: number, tempo: number, ts: TimeSignature): BarsBeats {
  // Quantise to ticks up front so rounding at the sub-beat level cannot leave a
  // dangling 960 that would otherwise read as "beat N, tick 0" of the wrong beat.
  const ticksPerBar = TICKS_PER_BEAT * ts.numerator
  const totalTicks = Math.round(secToBeats(sec, tempo, ts) * TICKS_PER_BEAT)
  const barIndex = Math.floor(totalTicks / ticksPerBar)
  const withinBar = totalTicks - barIndex * ticksPerBar
  const beatIndex = Math.floor(withinBar / TICKS_PER_BEAT)
  const ticks = withinBar - beatIndex * TICKS_PER_BEAT
  return { bar: barIndex + 1, beat: beatIndex + 1, ticks }
}

export function formatBarsBeats(bb: BarsBeats): string {
  const bar = String(bb.bar).padStart(3, '0')
  const ticks = String(bb.ticks).padStart(3, '0')
  return `${bar}.${bb.beat}.${ticks}`
}

export function snapSecToBar(sec: number, tempo: number, ts: TimeSignature): number {
  const spb = secondsPerBar(tempo, ts)
  return Math.round(sec / spb) * spb
}

export function snapSecToBeat(sec: number, tempo: number, ts: TimeSignature): number {
  const spb = secondsPerBeat(tempo, ts)
  return Math.round(sec / spb) * spb
}

/**
 * Align a take's raw start to the grid: audio captured `latencySec` late is
 * shifted earlier by that amount so it lands where it was actually played.
 * Clamped to zero — a take can never begin before the timeline origin.
 */
export function compensateRecordStart(rawStartSec: number, latencySec: number): number {
  return Math.max(0, rawStartSec - latencySec)
}
