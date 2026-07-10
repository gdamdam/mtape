import { describe, expect, it } from 'vitest'
import { initialState, reducer, type Action, type AppState } from './state'
import {
  defaultSession,
  GAIN_DB_MAX,
  TRACK_COUNT_MAX,
  TRACK_COUNT_MIN,
  type Clip,
} from '../audio/contracts'

function freshState(): AppState {
  return initialState(defaultSession('s1'))
}

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    audioId: 'a1',
    startSec: 4,
    offsetSec: 0,
    durationSec: 8,
    gainDb: 0,
    fades: { inSec: 0, outSec: 0 },
    ...over,
  }
}

/** Apply a sequence of actions for terser multi-step assertions. */
function run(state: AppState, ...actions: Action[]): AppState {
  return actions.reduce(reducer, state)
}

describe('initialState', () => {
  it('selects the first track and mirrors loop.enabled', () => {
    const s = freshState()
    expect(s.session.tracks).toHaveLength(TRACK_COUNT_MIN)
    expect(s.selectedTrackId).toBe(s.session.tracks[0].id)
    expect(s.selectedClipId).toBeNull()
    expect(s.audioReady).toBe(false)
    expect(s.snapToBar).toBe(true)
    expect(s.showLoopRegion).toBe(false)
  })
})

describe('transport + audio flags (kept off the session)', () => {
  it('flips audioReady and transport without touching the session', () => {
    const s0 = freshState()
    const s1 = run(s0, { type: 'SET_AUDIO_READY', ready: true }, { type: 'SET_TRANSPORT', playing: true, recording: false })
    expect(s1.audioReady).toBe(true)
    expect(s1.playing).toBe(true)
    expect(s1.session).toBe(s0.session) // session identity unchanged
  })
})

describe('tempo / time-signature / metronome', () => {
  it('clamps tempo to the legal range', () => {
    expect(reducer(freshState(), { type: 'SET_TEMPO', tempo: 9999 }).session.tempo).toBe(300)
    expect(reducer(freshState(), { type: 'SET_TEMPO', tempo: 1 }).session.tempo).toBe(20)
  })
  it('coerces an out-of-range denominator to 4', () => {
    const s = reducer(freshState(), { type: 'SET_TIME_SIG', timeSignature: { numerator: 6, denominator: 5 } })
    expect(s.session.timeSignature).toEqual({ numerator: 6, denominator: 4 })
  })
  it('toggles the metronome', () => {
    expect(reducer(freshState(), { type: 'TOGGLE_METRONOME' }).session.metronome).toBe(true)
  })
  it('clamps count-in bars', () => {
    expect(reducer(freshState(), { type: 'SET_COUNT_IN', countInBars: 99 }).session.countInBars).toBe(4)
  })
})

describe('loop + snap', () => {
  it('SET_LOOP orders an inverted region and syncs showLoopRegion', () => {
    const s = reducer(freshState(), { type: 'SET_LOOP', loop: { enabled: true, startSec: 10, endSec: 2 } })
    expect(s.session.loop).toEqual({ enabled: true, startSec: 2, endSec: 10 })
    expect(s.showLoopRegion).toBe(true)
  })
  it('TOGGLE_LOOP flips enabled and mirrors showLoopRegion', () => {
    const s = reducer(freshState(), { type: 'TOGGLE_LOOP' })
    expect(s.session.loop.enabled).toBe(true)
    expect(s.showLoopRegion).toBe(true)
  })
  it('TOGGLE_SNAP flips snapToBar only', () => {
    expect(reducer(freshState(), { type: 'TOGGLE_SNAP' }).snapToBar).toBe(false)
  })
})

describe('track params', () => {
  it('SET_TRACK_PARAM patches and clamps a track', () => {
    const s0 = freshState()
    const id = s0.session.tracks[1].id
    const s1 = reducer(s0, { type: 'SET_TRACK_PARAM', trackId: id, patch: { gainDb: 999, pan: -0.5, mute: true } })
    const t = s1.session.tracks[1]
    expect(t.gainDb).toBe(GAIN_DB_MAX)
    expect(t.pan).toBe(-0.5)
    expect(t.mute).toBe(true)
  })
  it('arming a track disarms every other track', () => {
    const s0 = freshState()
    const [a, b] = s0.session.tracks
    const s1 = run(
      s0,
      { type: 'SET_TRACK_PARAM', trackId: a.id, patch: { armed: true } },
      { type: 'SET_TRACK_PARAM', trackId: b.id, patch: { armed: true } },
    )
    expect(s1.session.tracks.filter((t) => t.armed).map((t) => t.id)).toEqual([b.id])
  })
})

describe('selection', () => {
  it('SELECT_TRACK to a different track clears the stale clip selection', () => {
    const s0 = seeded() // clip c1 on track 0, selected
    const other = s0.session.tracks[1].id
    const s1 = run(s0, { type: 'SELECT_CLIP', trackId: s0.session.tracks[0].id, clipId: 'c1' }, { type: 'SELECT_TRACK', trackId: other })
    expect(s1.selectedTrackId).toBe(other)
    expect(s1.selectedClipId).toBeNull()
  })
  it('SELECT_TRACK to the same track keeps the clip selection', () => {
    const tid = seeded().session.tracks[0].id
    const s0 = run(seeded(), { type: 'SELECT_CLIP', trackId: tid, clipId: 'c1' })
    const s1 = reducer(s0, { type: 'SELECT_TRACK', trackId: tid })
    expect(s1.selectedClipId).toBe('c1')
  })
  it('ADD_TRACK clears a stale clip selection from the previous track', () => {
    const tid = seeded().session.tracks[0].id
    const s0 = run(seeded(), { type: 'SELECT_CLIP', trackId: tid, clipId: 'c1' })
    const s1 = reducer(s0, { type: 'ADD_TRACK', id: 'extra' })
    expect(s1.selectedTrackId).toBe('extra')
    expect(s1.selectedClipId).toBeNull()
  })
})

describe('add / remove track bounds', () => {
  it('ADD_TRACK appends up to the max then no-ops', () => {
    let s = freshState()
    for (let i = 0; i < 10; i++) s = reducer(s, { type: 'ADD_TRACK', id: `new${i}` })
    expect(s.session.tracks).toHaveLength(TRACK_COUNT_MAX)
  })
  it('REMOVE_TRACK refuses to drop below the minimum', () => {
    const s0 = freshState() // exactly TRACK_COUNT_MIN tracks
    const s1 = reducer(s0, { type: 'REMOVE_TRACK', trackId: s0.session.tracks[0].id })
    expect(s1).toBe(s0)
  })
  it('REMOVE_TRACK fixes selection when the selected track is removed', () => {
    const s0 = reducer(freshState(), { type: 'ADD_TRACK', id: 'extra' })
    const s1 = run(s0, { type: 'SELECT_TRACK', trackId: 'extra' }, { type: 'REMOVE_TRACK', trackId: 'extra' })
    expect(s1.session.tracks.some((t) => t.id === 'extra')).toBe(false)
    expect(s1.selectedTrackId).toBe(s1.session.tracks[0].id)
  })
})

describe('clip lifecycle', () => {
  it('ADD_CLIP appends a sanitized clip and selects it', () => {
    const s0 = freshState()
    const tid = s0.session.tracks[0].id
    const s1 = reducer(s0, { type: 'ADD_CLIP', trackId: tid, clip: clip() })
    expect(s1.session.tracks[0].clips).toHaveLength(1)
    expect(s1.selectedClipId).toBe('c1')
  })
  it('ADD_CLIP drops a clip with no backing audio', () => {
    const s0 = freshState()
    const tid = s0.session.tracks[0].id
    const s1 = reducer(s0, { type: 'ADD_CLIP', trackId: tid, clip: clip({ audioId: '' }) })
    expect(s1).toBe(s0)
  })
  it('MOVE_CLIP repositions and clamps to >= 0', () => {
    const s0 = seeded()
    const tid = s0.session.tracks[0].id
    expect(reducer(s0, { type: 'MOVE_CLIP', trackId: tid, clipId: 'c1', startSec: -5 }).session.tracks[0].clips[0].startSec).toBe(0)
  })
  it('TRIM_IN keeps the source locked (offset walks with start)', () => {
    const s0 = seeded()
    const tid = s0.session.tracks[0].id
    const c = reducer(s0, { type: 'TRIM_IN', trackId: tid, clipId: 'c1', newStartSec: 6 }).session.tracks[0].clips[0]
    expect(c.startSec).toBeCloseTo(6)
    expect(c.offsetSec).toBeCloseTo(2)
    expect(c.durationSec).toBeCloseTo(6)
  })
  it('TRIM_OUT shortens duration', () => {
    const s0 = seeded()
    const tid = s0.session.tracks[0].id
    expect(reducer(s0, { type: 'TRIM_OUT', trackId: tid, clipId: 'c1', newEndSec: 9 }).session.tracks[0].clips[0].durationSec).toBeCloseTo(5)
  })
  it('SPLIT_CLIP replaces one clip with two contiguous halves', () => {
    const s0 = seeded()
    const tid = s0.session.tracks[0].id
    const clips = reducer(s0, { type: 'SPLIT_CLIP', trackId: tid, clipId: 'c1', atSec: 8, newIdA: 'A', newIdB: 'B' }).session.tracks[0].clips
    expect(clips.map((c) => c.id)).toEqual(['A', 'B'])
    expect(clips[0].durationSec).toBeCloseTo(4)
    expect(clips[1].startSec).toBeCloseTo(8)
    expect(clips[1].offsetSec).toBeCloseTo(4)
  })
  it('DUPLICATE_CLIP appends a copy under the new id', () => {
    const s0 = seeded()
    const tid = s0.session.tracks[0].id
    const s1 = reducer(s0, { type: 'DUPLICATE_CLIP', trackId: tid, clipId: 'c1', newId: 'dup', atSec: 20 })
    expect(s1.session.tracks[0].clips.map((c) => c.id)).toEqual(['c1', 'dup'])
    expect(s1.session.tracks[0].clips[1].startSec).toBe(20)
    expect(s1.selectedClipId).toBe('dup')
  })
  it('DELETE_CLIP removes it and clears the selection', () => {
    const s0 = seeded()
    const tid = s0.session.tracks[0].id
    const s1 = run(s0, { type: 'SELECT_CLIP', trackId: tid, clipId: 'c1' }, { type: 'DELETE_CLIP', trackId: tid, clipId: 'c1' })
    expect(s1.session.tracks[0].clips).toHaveLength(0)
    expect(s1.selectedClipId).toBeNull()
  })
  it('SET_CLIP_GAIN clamps to the gain ceiling', () => {
    const s0 = seeded()
    const tid = s0.session.tracks[0].id
    expect(reducer(s0, { type: 'SET_CLIP_GAIN', trackId: tid, clipId: 'c1', gainDb: 999 }).session.tracks[0].clips[0].gainDb).toBe(GAIN_DB_MAX)
  })
  it('SET_CLIP_FADES clamps a fade to the clip duration', () => {
    const s0 = seeded()
    const tid = s0.session.tracks[0].id
    // durationSec is 8 → an over-long fade is clamped down.
    expect(reducer(s0, { type: 'SET_CLIP_FADES', trackId: tid, clipId: 'c1', fades: { inSec: 100 } }).session.tracks[0].clips[0].fades.inSec).toBeCloseTo(8)
  })
})

describe('TRIM_OUT source cap (FIX #1)', () => {
  it('caps duration to the source length passed as maxDurationSec', () => {
    const s0 = seeded() // clip c1: startSec 4, offset 0, duration 8
    const tid = s0.session.tracks[0].id
    // Drag the out-point far past the source; a 6s source caps duration to 6.
    const c = reducer(s0, { type: 'TRIM_OUT', trackId: tid, clipId: 'c1', newEndSec: 100, maxDurationSec: 6 }).session.tracks[0].clips[0]
    expect(c.durationSec).toBeCloseTo(6)
  })

  it('a non-zero offset reduces the capped duration', () => {
    const s0 = freshState()
    const tid = s0.session.tracks[0].id
    const s1 = reducer(s0, { type: 'ADD_CLIP', trackId: tid, clip: clip({ offsetSec: 2 }) })
    // 6s source, 2s already consumed by the offset ⇒ 4s of playable material.
    const c = reducer(s1, { type: 'TRIM_OUT', trackId: tid, clipId: 'c1', newEndSec: 100, maxDurationSec: 6 }).session.tracks[0].clips[0]
    expect(c.durationSec).toBeCloseTo(4)
  })

  it('undefined maxDurationSec leaves the trim uncapped (pre-FIX behaviour)', () => {
    const s0 = seeded()
    const tid = s0.session.tracks[0].id
    // newEndSec 9 with startSec 4 ⇒ duration 5, exactly as before the cap existed.
    expect(reducer(s0, { type: 'TRIM_OUT', trackId: tid, clipId: 'c1', newEndSec: 9 }).session.tracks[0].clips[0].durationSec).toBeCloseTo(5)
  })
})

describe('atomicity (FIX #10)', () => {
  it('TRIM_OUT on a missing track leaves the session identity untouched', () => {
    const s0 = seeded()
    const s1 = reducer(s0, { type: 'TRIM_OUT', trackId: 'no-such-track', clipId: 'c1', newEndSec: 9 })
    expect(s1.session).toBe(s0.session) // no fork of the durable session
  })

  it('ADD_CLIP with an unbacked (audioId-less) clip returns the same state reference', () => {
    const s0 = freshState()
    const tid = s0.session.tracks[0].id
    expect(reducer(s0, { type: 'ADD_CLIP', trackId: tid, clip: clip({ audioId: '' }) })).toBe(s0)
  })

  it('DUPLICATE_CLIP of a missing clip returns the same state reference', () => {
    const s0 = seeded()
    const tid = s0.session.tracks[0].id
    expect(reducer(s0, { type: 'DUPLICATE_CLIP', trackId: tid, clipId: 'ghost', newId: 'x' })).toBe(s0)
  })

  it('ADD_TRACK at TRACK_COUNT_MAX returns the same state reference', () => {
    let s = freshState()
    while (s.session.tracks.length < TRACK_COUNT_MAX) s = reducer(s, { type: 'ADD_TRACK', id: `t${s.session.tracks.length}` })
    expect(reducer(s, { type: 'ADD_TRACK', id: 'overflow' })).toBe(s)
  })

  it('REMOVE_TRACK at TRACK_COUNT_MIN returns the same state reference', () => {
    const s0 = freshState() // exactly TRACK_COUNT_MIN tracks
    expect(reducer(s0, { type: 'REMOVE_TRACK', trackId: s0.session.tracks[0].id })).toBe(s0)
  })

  it('SPLIT_CLIP is one atomic dispatch: two valid halves, refs/fades/gain/frames preserved', () => {
    const s0 = freshState()
    const tid = s0.session.tracks[0].id
    const rich = clip({ id: 'whole', audioId: 'src1', startSec: 4, offsetSec: 2, durationSec: 8, gainDb: -4, fades: { inSec: 1, outSec: 1 } })
    const seededRich = reducer(s0, { type: 'ADD_CLIP', trackId: tid, clip: rich })
    const untouchedTrack = seededRich.session.tracks[1]

    const s1 = reducer(seededRich, { type: 'SPLIT_CLIP', trackId: tid, clipId: 'whole', atSec: 8, newIdA: 'A', newIdB: 'B' })
    // Atomic: a single new session; the non-target track keeps its identity.
    expect(s1.session).not.toBe(seededRich.session)
    expect(s1.session.tracks[1]).toBe(untouchedTrack)

    const [a, b] = s1.session.tracks[0].clips
    expect(s1.session.tracks[0].clips).toHaveLength(2)
    // Source refs preserved on both halves.
    expect(a.audioId).toBe('src1')
    expect(b.audioId).toBe('src1')
    // Gain preserved; fades routed in→A, out→B.
    expect(a.gainDb).toBe(-4)
    expect(b.gainDb).toBe(-4)
    expect(a.fades).toEqual({ inSec: 1, outSec: 0 })
    expect(b.fades).toEqual({ inSec: 0, outSec: 1 })
    // Frame-exact positions: A=[4,8], B=[8,12], B advances its source offset.
    expect(a.startSec).toBeCloseTo(4)
    expect(a.durationSec).toBeCloseTo(4)
    expect(b.startSec).toBeCloseTo(8)
    expect(b.offsetSec).toBeCloseTo(6) // 2 + 4
    expect(a.durationSec + b.durationSec).toBeCloseTo(8)
  })

  it('DUPLICATE_CLIP is one atomic dispatch: copy preserves source/gain/fades/duration and frame-exact start', () => {
    const s0 = freshState()
    const tid = s0.session.tracks[0].id
    const rich = clip({ id: 'orig', audioId: 'src1', startSec: 4, offsetSec: 2, durationSec: 8, gainDb: -4, fades: { inSec: 1, outSec: 1 } })
    const seededRich = reducer(s0, { type: 'ADD_CLIP', trackId: tid, clip: rich })
    const untouchedTrack = seededRich.session.tracks[1]

    const s1 = reducer(seededRich, { type: 'DUPLICATE_CLIP', trackId: tid, clipId: 'orig', newId: 'dup', atSec: 20 })
    expect(s1.session).not.toBe(seededRich.session)
    expect(s1.session.tracks[1]).toBe(untouchedTrack) // atomic: other track untouched

    const clips = s1.session.tracks[0].clips
    expect(clips.map((c) => c.id)).toEqual(['orig', 'dup'])
    const copy = clips[1]
    expect(copy.audioId).toBe('src1')
    expect(copy.gainDb).toBe(-4)
    expect(copy.offsetSec).toBeCloseTo(2)
    expect(copy.durationSec).toBeCloseTo(8)
    expect(copy.startSec).toBe(20) // frame-exact placement
    expect(copy.fades).toEqual({ inSec: 1, outSec: 1 })
    expect(copy.fades).not.toBe(clips[0].fades) // deep-copied, not aliased
  })
})

describe('master + session meta', () => {
  it('SET_MASTER merges and clamps', () => {
    const s = reducer(freshState(), { type: 'SET_MASTER', patch: { drive: 5, varispeed: 0.75 } })
    expect(s.session.master.drive).toBe(1)
    expect(s.session.master.varispeed).toBe(0.75)
  })
  it('RENAME_SESSION keeps the old name when given blank', () => {
    const s0 = freshState()
    expect(reducer(s0, { type: 'RENAME_SESSION', name: '   ' }).session.name).toBe(s0.session.name)
    expect(reducer(s0, { type: 'RENAME_SESSION', name: 'My song' }).session.name).toBe('My song')
  })
  it('LOAD_SESSION adopts a new session and resets transient UI', () => {
    const loaded = defaultSession('other')
    const s1 = run(freshState(), { type: 'SET_TRANSPORT', playing: true, recording: true }, { type: 'LOAD_SESSION', session: loaded })
    expect(s1.session.id).toBe('other')
    expect(s1.playing).toBe(false)
    expect(s1.recording).toBe(false)
    expect(s1.selectedClipId).toBeNull()
  })
  it('SET_STATUS carries a transient message', () => {
    expect(reducer(freshState(), { type: 'SET_STATUS', status: 'hi' }).status).toBe('hi')
  })
})

/** A state with one 8s clip on track 0 for the clip-transform tests. */
function seeded(): AppState {
  const s0 = freshState()
  return reducer(s0, { type: 'ADD_CLIP', trackId: s0.session.tracks[0].id, clip: clip() })
}
