import { describe, expect, it } from 'vitest'
import {
  CLIP_COUNT_MAX,
  defaultSession,
  isFutureSchema,
  sanitizeSession,
  sanitizeTrack,
  SESSION_SCHEMA_VERSION,
  type Clip,
} from './contracts'

function clip(i: number): Partial<Clip> {
  return { id: `c${i}`, audioId: `a${i}`, startSec: 0, offsetSec: 0, durationSec: 1, gainDb: 0 }
}

describe('clip-count cap (BUG A — DoS)', () => {
  it('sanitizeTrack keeps at most CLIP_COUNT_MAX clips and never throws', () => {
    const clips = Array.from({ length: CLIP_COUNT_MAX + 137 }, (_, i) => clip(i))
    let track!: ReturnType<typeof sanitizeTrack>
    expect(() => {
      track = sanitizeTrack({ id: 't1', clips })
    }).not.toThrow()
    // Exactly the cap kept (all inputs are valid + uniquely id'd, so none dropped
    // for other reasons); overflow silently dropped.
    expect(track.clips.length).toBe(CLIP_COUNT_MAX)
  })

  it('sanitizeSession enforces the cap per track and stays valid', () => {
    const s = sanitizeSession({
      tracks: [{ id: 't1', clips: Array.from({ length: CLIP_COUNT_MAX + 500 }, (_, i) => clip(i)) }],
    })
    expect(s.tracks[0].clips.length).toBe(CLIP_COUNT_MAX)
    expect(s.tracks.length).toBeGreaterThanOrEqual(4) // min-track padding intact
  })
})

describe('isFutureSchema (BUG B — newer schema not silently downgraded)', () => {
  it('flags a record whose schemaVersion is newer than this build', () => {
    expect(isFutureSchema({ schemaVersion: SESSION_SCHEMA_VERSION + 1 })).toBe(true)
  })

  it('accepts current and older versions, and is total for garbage', () => {
    expect(isFutureSchema({ schemaVersion: SESSION_SCHEMA_VERSION })).toBe(false)
    expect(isFutureSchema({ schemaVersion: SESSION_SCHEMA_VERSION - 1 })).toBe(false)
    expect(isFutureSchema({})).toBe(false)
    expect(isFutureSchema(null)).toBe(false)
    expect(isFutureSchema(42)).toBe(false)
    expect(isFutureSchema({ schemaVersion: Infinity })).toBe(false)
    expect(isFutureSchema({ schemaVersion: NaN })).toBe(false)
  })

  it('documents WHY the guard is needed: sanitizeSession would otherwise downgrade', () => {
    // sanitizeSession always stamps the current version, dropping the future one —
    // exactly the silent downgrade the DB read path guards against via isFutureSchema.
    const downgraded = sanitizeSession({ schemaVersion: SESSION_SCHEMA_VERSION + 1, id: 'x' })
    expect(downgraded.schemaVersion).toBe(SESSION_SCHEMA_VERSION)
  })
})

describe('duplicate id de-duplication (BUG C)', () => {
  it('renames colliding TRACK ids deterministically', () => {
    const s = sanitizeSession({
      tracks: [
        { id: 'dup', name: 'A' },
        { id: 'dup', name: 'B' },
        { id: 'dup', name: 'C' },
      ],
    })
    const ids = s.tracks.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length) // all unique
    expect(ids.slice(0, 3)).toEqual(['dup', 'dup-2', 'dup-3'])
  })

  it('renames colliding CLIP ids within a track', () => {
    const s = sanitizeSession({
      tracks: [{ id: 't1', clips: [{ ...clip(1), id: 'k' }, { ...clip(2), id: 'k' }, { ...clip(3), id: 'k' }] }],
    })
    const ids = s.tracks[0].clips.map((c) => c.id)
    expect(ids).toEqual(['k', 'k-2', 'k-3'])
  })

  it('leaves a valid unique-id session unchanged (value-stable)', () => {
    const base = defaultSession('demo')
    base.tracks[0].clips = [{ id: 'c1', audioId: 'a1', startSec: 0, offsetSec: 0, durationSec: 2, gainDb: 0, fades: { inSec: 0, outSec: 0 } }]
    const once = sanitizeSession(base)
    // Idempotent: sanitizing an already-clean session is a no-op in value.
    expect(sanitizeSession(once)).toEqual(once)
  })
})

describe('non-finite fallbacks (clampNumber regression guard)', () => {
  it('coerces NaN/Infinity in tempo, gains and positions to safe values', () => {
    const s = sanitizeSession({
      tempo: NaN,
      master: { gainDb: Infinity },
      tracks: [{ id: 't1', gainDb: -Infinity, pan: NaN, clips: [{ id: 'c1', audioId: 'a1', startSec: NaN, offsetSec: Infinity, durationSec: NaN, gainDb: NaN }] }],
    })
    expect(Number.isFinite(s.tempo)).toBe(true)
    expect(Number.isFinite(s.master.gainDb)).toBe(true)
    expect(Number.isFinite(s.tracks[0].gainDb)).toBe(true)
    expect(Number.isFinite(s.tracks[0].pan)).toBe(true)
    const c = s.tracks[0].clips[0]
    expect(Number.isFinite(c.startSec) && Number.isFinite(c.offsetSec) && Number.isFinite(c.durationSec) && Number.isFinite(c.gainDb)).toBe(true)
  })
})
