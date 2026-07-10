import { describe, expect, it } from 'vitest'

import type { Clip } from '../audio/contracts'
import {
  clipEndSec,
  duplicateClip,
  fadeGainAt,
  moveClip,
  setClipStart,
  snapSecToGrid,
  splitClip,
  trimIn,
  trimOut,
} from './clipMath'

// A representative clip: sits at t=10, plays 20s of source starting 5s in,
// with a 2s in-fade and a 3s out-fade.
function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    audioId: 'a1',
    name: 'take',
    startSec: 10,
    offsetSec: 5,
    durationSec: 20,
    gainDb: -3,
    fades: { inSec: 2, outSec: 3 },
    ...overrides,
  }
}

// Deep freeze so any accidental mutation of the input throws instead of passing.
function freeze<T>(obj: T): T {
  Object.freeze((obj as { fades?: unknown }).fades)
  return Object.freeze(obj)
}

describe('clipEndSec', () => {
  it('is startSec + durationSec', () => {
    expect(clipEndSec(makeClip())).toBe(30)
  })
})

describe('no-mutation contract', () => {
  it('none of the transforms mutate their input', () => {
    const clip = freeze(makeClip())
    // Frozen input + strict mode => a mutating impl would throw here.
    expect(() => moveClip(clip, 5)).not.toThrow()
    expect(() => setClipStart(clip, 3)).not.toThrow()
    expect(() => trimIn(clip, 12)).not.toThrow()
    expect(() => trimOut(clip, 25)).not.toThrow()
    expect(() => splitClip(clip, 15, 'a', 'b')).not.toThrow()
    expect(() => duplicateClip(clip, 'x')).not.toThrow()
    // And a returned clip is a distinct object.
    expect(moveClip(clip, 5)).not.toBe(clip)
  })
})

describe('moveClip', () => {
  it('shifts by delta', () => {
    expect(moveClip(makeClip(), 5).startSec).toBe(15)
  })
  it('clamps a negative move to 0', () => {
    expect(moveClip(makeClip(), -1000).startSec).toBe(0)
  })
})

describe('setClipStart', () => {
  it('sets an absolute start', () => {
    expect(setClipStart(makeClip(), 42).startSec).toBe(42)
  })
  it('clamps negatives to 0', () => {
    expect(setClipStart(makeClip(), -5).startSec).toBe(0)
  })
})

describe('trimIn', () => {
  it('drags the in-point right: source stays locked, duration shrinks', () => {
    const out = trimIn(makeClip(), 13) // delta = +3
    expect(out.startSec).toBeCloseTo(13)
    expect(out.offsetSec).toBeCloseTo(8) // 5 + 3
    expect(out.durationSec).toBeCloseTo(17) // 20 - 3
    // Out-point on the timeline is unchanged (source locked).
    expect(clipEndSec(out)).toBeCloseTo(30)
  })

  it('drags the in-point left, walking offset back toward the source start', () => {
    const out = trimIn(makeClip(), 8) // delta = -2
    expect(out.startSec).toBeCloseTo(8)
    expect(out.offsetSec).toBeCloseTo(3)
    expect(out.durationSec).toBeCloseTo(22)
  })

  it('clamps so offsetSec never goes negative', () => {
    // Would need delta = -10 but only 5s of source lead-in exists.
    const out = trimIn(makeClip(), 0)
    expect(out.offsetSec).toBeCloseTo(0)
    expect(out.startSec).toBeCloseTo(5) // start moved by the clamped -5
    expect(out.durationSec).toBeCloseTo(25)
  })

  it('cannot reach or pass the clip end (duration stays > 0)', () => {
    const out = trimIn(makeClip(), 999)
    expect(out.durationSec).toBeGreaterThan(0)
    expect(out.startSec).toBeLessThan(clipEndSec(makeClip()))
  })

  it('clamps startSec to 0 without shifting the audio (offset stops short of its lead-in)', () => {
    // startSec 1 with 5s of lead-in: the offset clamp alone would allow delta
    // down to -5 and drive startSec to -4. The startSec>=0 invariant must bind
    // first (delta = -1), or the persistence sanitizer later clamps startSec to
    // 0 without compensating offset/duration and shifts the audio.
    const clip = makeClip({ startSec: 1, offsetSec: 5, durationSec: 10 })
    const out = trimIn(clip, -2)
    expect(out.startSec).toBe(0)
    expect(out.offsetSec).toBeCloseTo(4) // 5 + (-1), still positive
    expect(out.durationSec).toBeCloseTo(11) // 10 - (-1)
    // Source stays locked: the timeline out-point is unchanged.
    expect(clipEndSec(out)).toBeCloseTo(clipEndSec(clip))
  })
})

describe('trimOut', () => {
  it('sets duration from an absolute end', () => {
    expect(trimOut(makeClip(), 25).durationSec).toBeCloseTo(15)
  })
  it('cannot collapse to zero or below', () => {
    expect(trimOut(makeClip(), 10).durationSec).toBeGreaterThan(0)
    expect(trimOut(makeClip(), 5).durationSec).toBeGreaterThan(0)
  })

  describe('source cap (maxSourceSec)', () => {
    it('undefined maxSourceSec keeps the pre-cap behaviour (no cap)', () => {
      // 1000s past the source: with no cap it extends freely, exactly as before.
      expect(trimOut(makeClip(), 1000).durationSec).toBeCloseTo(990)
    })

    it('trims out exactly at the source end (offset 0)', () => {
      const c = makeClip({ startSec: 0, offsetSec: 0, durationSec: 4 })
      // 10s of source, drag the out-point precisely to the source end.
      expect(trimOut(c, 10, 10).durationSec).toBeCloseTo(10)
      expect(clipEndSec(trimOut(c, 10, 10))).toBeCloseTo(10)
    })

    it('trims out exactly at the source end (non-zero offset)', () => {
      // offset 5 into a 20s source ⇒ 15s of playable material remain.
      const c = makeClip() // startSec 10, offset 5
      const out = trimOut(c, 25, 20) // exactly source end
      expect(out.durationSec).toBeCloseTo(15)
      expect(clipEndSec(out)).toBeCloseTo(25)
    })

    it('clamps a trim past the source end back to the source', () => {
      const out = trimOut(makeClip(), 1000, 20) // way past; source is 20s
      expect(out.durationSec).toBeCloseTo(15) // 20 - offset 5
      expect(clipEndSec(out)).toBeCloseTo(25)
    })

    it('a non-zero offset reduces the available duration', () => {
      // Same 20s source, same requested end, only the offset differs.
      const atZero = trimOut(makeClip({ offsetSec: 0 }), 1000, 20)
      const atFive = trimOut(makeClip({ offsetSec: 5 }), 1000, 20)
      expect(atZero.durationSec).toBeCloseTo(20)
      expect(atFive.durationSec).toBeCloseTo(15)
    })

    it('never clamps below MIN_DURATION when offset exceeds the source', () => {
      // offset (5) past a tiny 3s source ⇒ cap would be negative; MIN floor wins.
      const out = trimOut(makeClip(), 1000, 3)
      expect(out.durationSec).toBeGreaterThan(0)
      expect(out.durationSec).toBeLessThan(1e-3)
    })

    it('still clamps after split → the B half advances its offset', () => {
      // Split makeClip (offset 5) at 18: B.offset = 5 + 8 = 13 into a 20s source.
      const [, b] = splitClip(makeClip(), 18, 'A', 'B')
      const out = trimOut(b, 1000, 20)
      expect(out.durationSec).toBeCloseTo(7) // 20 - 13
      expect(clipEndSec(out)).toBeCloseTo(25)
    })

    it('still clamps after duplicate (offset preserved)', () => {
      const dup = duplicateClip(makeClip(), 'c2') // startSec 30, offset 5
      const out = trimOut(dup, 1000, 20)
      expect(out.durationSec).toBeCloseTo(15) // 20 - 5
    })

    it('still clamps after move (offset preserved, start shifted)', () => {
      const moved = moveClip(makeClip(), 5) // startSec 15, offset 5
      const out = trimOut(moved, 1000, 20)
      expect(out.durationSec).toBeCloseTo(15) // 20 - 5
      expect(clipEndSec(out)).toBeCloseTo(30) // 15 + 15
    })
  })
})

describe('splitClip', () => {
  it('splits into abutting halves that reconstruct the original span', () => {
    const clip = makeClip()
    const [a, b] = splitClip(clip, 18, 'A', 'B')

    expect(a.id).toBe('A')
    expect(b.id).toBe('B')
    // A = [start, atSec]
    expect(a.startSec).toBe(10)
    expect(a.durationSec).toBeCloseTo(8)
    // B = [atSec, end]
    expect(b.startSec).toBe(18)
    expect(b.durationSec).toBeCloseTo(12)

    // Reconstruction invariants.
    expect(a.durationSec + b.durationSec).toBeCloseTo(clip.durationSec)
    expect(b.offsetSec).toBeCloseTo(a.offsetSec + a.durationSec)
    expect(clipEndSec(b)).toBeCloseTo(clipEndSec(clip))
  })

  it('routes fades: in-fade to A, out-fade to B', () => {
    const [a, b] = splitClip(makeClip(), 18, 'A', 'B')
    expect(a.fades).toEqual({ inSec: 2, outSec: 0 })
    expect(b.fades).toEqual({ inSec: 0, outSec: 3 })
  })

  it('preserves audioId and gainDb on both halves', () => {
    const [a, b] = splitClip(makeClip(), 18, 'A', 'B')
    expect(a.audioId).toBe('a1')
    expect(b.audioId).toBe('a1')
    expect(a.gainDb).toBe(-3)
    expect(b.gainDb).toBe(-3)
  })

  it('clamps an atSec outside the clip so both halves stay positive', () => {
    const clip = makeClip()
    const [a, b] = splitClip(clip, 1000, 'A', 'B')
    expect(a.durationSec).toBeGreaterThan(0)
    expect(b.durationSec).toBeGreaterThan(0)
    // Still reconstructs the full span even when clamped.
    expect(a.durationSec + b.durationSec).toBeCloseTo(clip.durationSec)
  })
})

describe('duplicateClip', () => {
  it('places the copy right after the original by default', () => {
    const dup = duplicateClip(makeClip(), 'c2')
    expect(dup.id).toBe('c2')
    expect(dup.startSec).toBe(30) // clipEndSec
    expect(dup.audioId).toBe('a1')
    expect(dup.durationSec).toBe(20)
  })
  it('honors an explicit target position', () => {
    expect(duplicateClip(makeClip(), 'c2', 100).startSec).toBe(100)
  })
  it('copies fades into a fresh object', () => {
    const clip = makeClip()
    const dup = duplicateClip(clip, 'c2')
    expect(dup.fades).toEqual(clip.fades)
    expect(dup.fades).not.toBe(clip.fades)
  })
})

describe('snapSecToGrid', () => {
  it('rounds to the nearest grid line', () => {
    expect(snapSecToGrid(1.2, 0.5)).toBeCloseTo(1.0)
    expect(snapSecToGrid(1.3, 0.5)).toBeCloseTo(1.5)
  })
  it('returns the input unchanged when gridSec <= 0', () => {
    expect(snapSecToGrid(1.234, 0)).toBe(1.234)
    expect(snapSecToGrid(1.234, -1)).toBe(1.234)
  })
})

describe('fadeGainAt', () => {
  const clip = makeClip() // inSec 2, outSec 3, duration 20

  it('is 0 outside the clip', () => {
    expect(fadeGainAt(clip, -0.001)).toBe(0)
    expect(fadeGainAt(clip, 20.001)).toBe(0)
  })

  it('has 0 at both endpoints', () => {
    expect(fadeGainAt(clip, 0)).toBeCloseTo(0)
    expect(fadeGainAt(clip, 20)).toBeCloseTo(0)
  })

  it('ramps linearly through the in-fade', () => {
    expect(fadeGainAt(clip, 1)).toBeCloseTo(0.5) // halfway up a 2s in-fade
  })

  it('ramps linearly through the out-fade', () => {
    expect(fadeGainAt(clip, 18.5)).toBeCloseTo(0.5) // halfway down a 3s out-fade
  })

  it('is unity across the sustain (midpoint)', () => {
    expect(fadeGainAt(clip, 10)).toBeCloseTo(1)
  })

  it('is unity everywhere in the sustain region', () => {
    expect(fadeGainAt(clip, 2)).toBeCloseTo(1) // end of in-fade
    expect(fadeGainAt(clip, 17)).toBeCloseTo(1) // start of out-fade
  })

  it('takes the min when in/out fades overlap', () => {
    // 6s clip with a 5s in-fade and a 5s out-fade: the ramps cross at the middle.
    const overlap = makeClip({ durationSec: 6, fades: { inSec: 5, outSec: 5 } })
    // At t=3 (center): inGain=3/5=0.6, outGain=(6-3)/5=0.6 => min 0.6.
    expect(fadeGainAt(overlap, 3)).toBeCloseTo(0.6)
    // At t=1: inGain=0.2, outGain=1 (capped) => 0.2.
    expect(fadeGainAt(overlap, 1)).toBeCloseTo(0.2)
    // At t=5: inGain=1 (capped), outGain=0.2 => 0.2.
    expect(fadeGainAt(overlap, 5)).toBeCloseTo(0.2)
  })

  it('is unity in the sustain when there are no fades', () => {
    const dry = makeClip({ fades: { inSec: 0, outSec: 0 } })
    expect(fadeGainAt(dry, 10)).toBeCloseTo(1)
  })
})
