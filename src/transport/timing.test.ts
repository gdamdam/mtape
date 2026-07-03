import { describe, expect, it } from 'vitest'
import type { TimeSignature } from '../audio/contracts'
import {
  TICKS_PER_BEAT,
  beatsToSec,
  compensateRecordStart,
  formatBarsBeats,
  secToBarsBeats,
  secToBars,
  secToBeats,
  secondsPerBar,
  secondsPerBeat,
  snapSecToBar,
  snapSecToBeat,
} from './timing'

const FOUR_FOUR: TimeSignature = { numerator: 4, denominator: 4 }
const SIX_EIGHT: TimeSignature = { numerator: 6, denominator: 8 }
const THREE_FOUR: TimeSignature = { numerator: 3, denominator: 4 }

describe('secondsPerBeat / secondsPerBar', () => {
  // Known values: quarter-note beat at 120 = 0.5s, bar = 2.0s.
  it('120bpm 4/4', () => {
    expect(secondsPerBeat(120, FOUR_FOUR)).toBeCloseTo(0.5, 10)
    expect(secondsPerBar(120, FOUR_FOUR)).toBeCloseTo(2.0, 10)
  })

  it('90bpm 4/4', () => {
    expect(secondsPerBeat(90, FOUR_FOUR)).toBeCloseTo(2 / 3, 10)
    expect(secondsPerBar(90, FOUR_FOUR)).toBeCloseTo(8 / 3, 10)
  })

  // 6/8: the beat is an eighth-note, so it is half a quarter-note.
  it('120bpm 6/8 (non-4/4 denominator)', () => {
    expect(secondsPerBeat(120, SIX_EIGHT)).toBeCloseTo(0.25, 10)
    expect(secondsPerBar(120, SIX_EIGHT)).toBeCloseTo(1.5, 10)
  })

  it('60bpm 3/4', () => {
    expect(secondsPerBeat(60, THREE_FOUR)).toBeCloseTo(1.0, 10)
    expect(secondsPerBar(60, THREE_FOUR)).toBeCloseTo(3.0, 10)
  })
})

describe('sec <-> beats <-> bars', () => {
  it('secToBeats / beatsToSec are inverses', () => {
    for (const sec of [0, 0.5, 1.234, 12.7]) {
      expect(beatsToSec(secToBeats(sec, 120, FOUR_FOUR), 120, FOUR_FOUR)).toBeCloseTo(sec, 10)
    }
  })

  it('secToBeats known values', () => {
    expect(secToBeats(2.0, 120, FOUR_FOUR)).toBeCloseTo(4, 10) // one bar = 4 beats
    expect(secToBeats(1.5, 120, SIX_EIGHT)).toBeCloseTo(6, 10) // one 6/8 bar = 6 beats
  })

  it('secToBars known values', () => {
    expect(secToBars(2.0, 120, FOUR_FOUR)).toBeCloseTo(1, 10)
    expect(secToBars(3.0, 120, FOUR_FOUR)).toBeCloseTo(1.5, 10)
    expect(secToBars(3.0, 120, SIX_EIGHT)).toBeCloseTo(2, 10)
  })
})

describe('secToBarsBeats', () => {
  it('origin and bar boundary at 120bpm 4/4', () => {
    expect(secToBarsBeats(0, 120, FOUR_FOUR)).toEqual({ bar: 1, beat: 1, ticks: 0 })
    // 2.0s is exactly one bar -> start of bar 2.
    expect(secToBarsBeats(2.0, 120, FOUR_FOUR)).toEqual({ bar: 2, beat: 1, ticks: 0 })
  })

  it('sub-beat ticks decomposition', () => {
    // 3.25s = 1 bar + 2 beats + half a beat -> bar 2, beat 3, tick 480.
    expect(secToBarsBeats(3.25, 120, FOUR_FOUR)).toEqual({ bar: 2, beat: 3, ticks: 480 })
    // Each beat = 0.5s -> beat 2 of bar 1 at 0.5s.
    expect(secToBarsBeats(0.5, 120, FOUR_FOUR)).toEqual({ bar: 1, beat: 2, ticks: 0 })
  })

  it('a quarter of a beat is 240 ticks', () => {
    expect(secToBarsBeats(0.125, 120, FOUR_FOUR)).toEqual({ bar: 1, beat: 1, ticks: 240 })
  })

  it('rounding at the sub-beat level carries into the next beat, never leaving 960', () => {
    // A time an epsilon short of a full beat must round up to the next beat,
    // not report ticks === TICKS_PER_BEAT on the current beat.
    const almostOneBeat = 0.5 - 1e-9
    const bb = secToBarsBeats(almostOneBeat, 120, FOUR_FOUR)
    expect(bb).toEqual({ bar: 1, beat: 2, ticks: 0 })
    expect(bb.ticks).toBeLessThan(TICKS_PER_BEAT)
  })

  it('non-4/4 bar length', () => {
    // 6/8 bar = 1.5s; 1.5s starts bar 2.
    expect(secToBarsBeats(1.5, 120, SIX_EIGHT)).toEqual({ bar: 2, beat: 1, ticks: 0 })
    // Fourth eighth-note of bar 1 at 0.75s (3 beats in).
    expect(secToBarsBeats(0.75, 120, SIX_EIGHT)).toEqual({ bar: 1, beat: 4, ticks: 0 })
  })
})

describe('formatBarsBeats', () => {
  it('zero-pads bar and ticks', () => {
    expect(formatBarsBeats({ bar: 1, beat: 1, ticks: 0 })).toBe('001.1.000')
    expect(formatBarsBeats({ bar: 2, beat: 3, ticks: 480 })).toBe('002.3.480')
    expect(formatBarsBeats({ bar: 123, beat: 4, ticks: 7 })).toBe('123.4.007')
  })

  it('round-trips a computed position', () => {
    expect(formatBarsBeats(secToBarsBeats(3.25, 120, FOUR_FOUR))).toBe('002.3.480')
  })
})

describe('snapSecToBar / snapSecToBeat', () => {
  it('snaps to nearest beat boundary', () => {
    // beat = 0.5s at 120bpm.
    expect(snapSecToBeat(0.4, 120, FOUR_FOUR)).toBeCloseTo(0.5, 10)
    expect(snapSecToBeat(0.2, 120, FOUR_FOUR)).toBeCloseTo(0, 10)
  })

  it('leaves an exactly-on-boundary time unchanged', () => {
    expect(snapSecToBeat(1.5, 120, FOUR_FOUR)).toBeCloseTo(1.5, 10)
    expect(snapSecToBar(4.0, 120, FOUR_FOUR)).toBeCloseTo(4.0, 10)
  })

  it('midpoint rounds up (half-away-from-zero via Math.round)', () => {
    // 0.25s is exactly halfway between beat boundaries 0 and 0.5 -> snaps to 0.5.
    expect(snapSecToBeat(0.25, 120, FOUR_FOUR)).toBeCloseTo(0.5, 10)
    // 1.0s is halfway between bars 0 (0s) and 1 (2s) -> snaps to 2.0.
    expect(snapSecToBar(1.0, 120, FOUR_FOUR)).toBeCloseTo(2.0, 10)
  })

  it('snaps to nearest bar boundary', () => {
    expect(snapSecToBar(2.3, 120, FOUR_FOUR)).toBeCloseTo(2.0, 10)
    expect(snapSecToBar(3.1, 120, FOUR_FOUR)).toBeCloseTo(4.0, 10)
  })
})

describe('compensateRecordStart', () => {
  it('shifts a late take earlier by the latency', () => {
    expect(compensateRecordStart(4.0, 0.02)).toBeCloseTo(3.98, 10)
  })

  it('is a no-op at zero latency', () => {
    expect(compensateRecordStart(4.0, 0)).toBeCloseTo(4.0, 10)
  })

  it('clamps to zero when latency exceeds the raw start', () => {
    expect(compensateRecordStart(0.01, 0.05)).toBe(0)
    expect(compensateRecordStart(0, 0.03)).toBe(0)
  })
})
