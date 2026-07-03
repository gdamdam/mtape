// mtape — the single reducer for all *durable* UI state.
//
// PURE: this module owns nothing that changes 30–60×/s. Playhead position and
// meter levels are deliberately kept OUT of here (they live in refs the engine
// event handler writes) so a running transport never triggers a reducer render
// storm. Everything here is a discrete, user-driven edit.
//
// Every mutation that touches the session routes through the contracts
// sanitizers / clipMath so the reducer can only ever produce a VALID Session —
// the same guarantee storage and sharing rely on. Ids for new clips/tracks are
// minted by the caller and passed in the action, keeping the reducer
// deterministic (no crypto, no clock).

import {
  clampInt,
  clampNumber,
  sanitizeClip,
  sanitizeLoop,
  sanitizeMaster,
  sanitizeName,
  sanitizeSession,
  sanitizeTimeSignature,
  sanitizeTrack,
  COUNT_IN_BARS_MAX,
  GAIN_DB_MAX,
  GAIN_DB_MIN,
  TEMPO_MAX,
  TEMPO_MIN,
  TRACK_COUNT_MAX,
  TRACK_COUNT_MIN,
  type Clip,
  type ClipFades,
  type LoopRegion,
  type MasterBus,
  type Session,
  type TimeSignature,
  type Track,
} from '../audio/contracts'
import { duplicateClip, setClipStart, splitClip, trimIn, trimOut } from '../clips/clipMath'

export interface AppState {
  session: Session
  audioReady: boolean
  playing: boolean
  recording: boolean
  selectedTrackId: string | null
  selectedClipId: string | null
  snapToBar: boolean
  showLoopRegion: boolean
  /** Transient user-facing message (e.g. a degraded-capability notice). */
  status: string | null
}

export type Action =
  | { type: 'SET_AUDIO_READY'; ready: boolean }
  | { type: 'SET_TRANSPORT'; playing: boolean; recording: boolean }
  | { type: 'SET_TEMPO'; tempo: number }
  | { type: 'SET_TIME_SIG'; timeSignature: TimeSignature }
  | { type: 'TOGGLE_METRONOME' }
  | { type: 'SET_COUNT_IN'; countInBars: number }
  | { type: 'SET_LOOP'; loop: LoopRegion }
  | { type: 'TOGGLE_LOOP' }
  | { type: 'TOGGLE_SNAP' }
  | { type: 'SELECT_TRACK'; trackId: string | null }
  | { type: 'SELECT_CLIP'; trackId: string; clipId: string | null }
  | { type: 'SET_TRACK_PARAM'; trackId: string; patch: Partial<Track> }
  | { type: 'ADD_TRACK'; id: string }
  | { type: 'REMOVE_TRACK'; trackId: string }
  | { type: 'ADD_CLIP'; trackId: string; clip: Clip }
  | { type: 'UPDATE_CLIP'; trackId: string; clipId: string; clip: Clip }
  | { type: 'MOVE_CLIP'; trackId: string; clipId: string; startSec: number }
  | { type: 'TRIM_IN'; trackId: string; clipId: string; newStartSec: number }
  | { type: 'TRIM_OUT'; trackId: string; clipId: string; newEndSec: number }
  | { type: 'SPLIT_CLIP'; trackId: string; clipId: string; atSec: number; newIdA: string; newIdB: string }
  | { type: 'DUPLICATE_CLIP'; trackId: string; clipId: string; newId: string; atSec?: number }
  | { type: 'DELETE_CLIP'; trackId: string; clipId: string }
  | { type: 'SET_CLIP_GAIN'; trackId: string; clipId: string; gainDb: number }
  | { type: 'SET_CLIP_FADES'; trackId: string; clipId: string; fades: Partial<ClipFades> }
  | { type: 'SET_MASTER'; patch: Partial<MasterBus> }
  | { type: 'RENAME_SESSION'; name: string }
  | { type: 'LOAD_SESSION'; session: Session }
  | { type: 'NEW_SESSION'; session: Session }
  | { type: 'SET_STATUS'; status: string | null }

export function initialState(session: Session): AppState {
  const clean = sanitizeSession(session)
  return {
    session: clean,
    audioReady: false,
    playing: false,
    recording: false,
    selectedTrackId: clean.tracks[0]?.id ?? null,
    selectedClipId: null,
    snapToBar: true,
    showLoopRegion: clean.loop.enabled,
    status: null,
  }
}

// --- small structural helpers (each returns a new object; never mutates) ---

/** Replace one track by id, re-sanitizing the produced track at its index. */
function mapTrack(session: Session, trackId: string, fn: (t: Track, index: number) => Track): Session {
  let touched = false
  const tracks = session.tracks.map((t, i) => {
    if (t.id !== trackId) return t
    touched = true
    return fn(t, i)
  })
  return touched ? { ...session, tracks } : session
}

/** Replace one clip inside one track; the produced clip is re-sanitized so
 *  clip-level invariants (fades ≤ duration, non-negative offset) always hold. */
function mapClip(session: Session, trackId: string, clipId: string, fn: (c: Clip) => Clip): Session {
  return mapTrack(session, trackId, (t) => ({
    ...t,
    clips: t.clips.map((c) => (c.id === clipId ? (sanitizeClip(fn(c)) ?? c) : c)),
  }))
}

/** Load a validated session while resetting the volatile per-session UI. */
function adoptSession(state: AppState, session: Session): AppState {
  const clean = sanitizeSession(session)
  return {
    ...state,
    session: clean,
    playing: false,
    recording: false,
    selectedTrackId: clean.tracks[0]?.id ?? null,
    selectedClipId: null,
    showLoopRegion: clean.loop.enabled,
  }
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_AUDIO_READY':
      return { ...state, audioReady: action.ready }

    case 'SET_TRANSPORT':
      return { ...state, playing: action.playing, recording: action.recording }

    case 'SET_TEMPO':
      return { ...state, session: { ...state.session, tempo: clampNumber(action.tempo, TEMPO_MIN, TEMPO_MAX, state.session.tempo) } }

    case 'SET_TIME_SIG':
      return { ...state, session: { ...state.session, timeSignature: sanitizeTimeSignature(action.timeSignature) } }

    case 'TOGGLE_METRONOME':
      return { ...state, session: { ...state.session, metronome: !state.session.metronome } }

    case 'SET_COUNT_IN':
      return { ...state, session: { ...state.session, countInBars: clampInt(action.countInBars, 0, COUNT_IN_BARS_MAX, state.session.countInBars) } }

    case 'SET_LOOP': {
      const loop = sanitizeLoop(action.loop)
      return { ...state, session: { ...state.session, loop }, showLoopRegion: loop.enabled }
    }

    case 'TOGGLE_LOOP': {
      const loop: LoopRegion = { ...state.session.loop, enabled: !state.session.loop.enabled }
      return { ...state, session: { ...state.session, loop }, showLoopRegion: loop.enabled }
    }

    case 'TOGGLE_SNAP':
      return { ...state, snapToBar: !state.snapToBar }

    case 'SELECT_TRACK':
      return { ...state, selectedTrackId: action.trackId }

    case 'SELECT_CLIP':
      return { ...state, selectedTrackId: action.trackId, selectedClipId: action.clipId }

    case 'SET_TRACK_PARAM': {
      // Arming a track is exclusive: only one input can be live at a time, so
      // arming one disarms the rest. Every other patch is local to its track.
      const arming = action.patch.armed === true
      const tracks = state.session.tracks.map((t, i) => {
        if (t.id === action.trackId) return sanitizeTrack({ ...t, ...action.patch }, i)
        return arming && t.armed ? { ...t, armed: false } : t
      })
      return { ...state, session: { ...state.session, tracks } }
    }

    case 'ADD_TRACK': {
      if (state.session.tracks.length >= TRACK_COUNT_MAX) return state
      const index = state.session.tracks.length
      const track = sanitizeTrack({ id: action.id, name: `Track ${index + 1}` }, index)
      return { ...state, session: { ...state.session, tracks: [...state.session.tracks, track] }, selectedTrackId: track.id }
    }

    case 'REMOVE_TRACK': {
      if (state.session.tracks.length <= TRACK_COUNT_MIN) return state
      const tracks = state.session.tracks.filter((t) => t.id !== action.trackId)
      if (tracks.length === state.session.tracks.length) return state
      const selectedTrackId = state.selectedTrackId === action.trackId ? (tracks[0]?.id ?? null) : state.selectedTrackId
      const selectedClipId = state.selectedTrackId === action.trackId ? null : state.selectedClipId
      return { ...state, session: { ...state.session, tracks }, selectedTrackId, selectedClipId }
    }

    case 'ADD_CLIP': {
      const clip = sanitizeClip(action.clip)
      if (!clip) return state
      return mapTrackReturn(state, action.trackId, (t) => ({ ...t, clips: [...t.clips, clip] }), clip.id)
    }

    case 'UPDATE_CLIP': {
      const clip = sanitizeClip(action.clip)
      if (!clip) return state
      return { ...state, session: mapClip(state.session, action.trackId, action.clipId, () => clip) }
    }

    case 'MOVE_CLIP':
      return { ...state, session: mapClip(state.session, action.trackId, action.clipId, (c) => setClipStart(c, action.startSec)) }

    case 'TRIM_IN':
      return { ...state, session: mapClip(state.session, action.trackId, action.clipId, (c) => trimIn(c, action.newStartSec)) }

    case 'TRIM_OUT':
      return { ...state, session: mapClip(state.session, action.trackId, action.clipId, (c) => trimOut(c, action.newEndSec)) }

    case 'SPLIT_CLIP':
      return {
        ...state,
        session: mapTrack(state.session, action.trackId, (t) => ({
          ...t,
          clips: t.clips.flatMap((c) => {
            if (c.id !== action.clipId) return [c]
            const [a, b] = splitClip(c, action.atSec, action.newIdA, action.newIdB)
            // Both halves are already valid by construction, but re-sanitize to
            // absorb any degenerate sub-epsilon split at a clip boundary.
            return [sanitizeClip(a), sanitizeClip(b)].filter((x): x is Clip => x !== null)
          }),
        })),
      }

    case 'DUPLICATE_CLIP': {
      const source = findClip(state.session, action.trackId, action.clipId)
      if (!source) return state
      const copy = sanitizeClip(duplicateClip(source, action.newId, action.atSec))
      if (!copy) return state
      return mapTrackReturn(state, action.trackId, (t) => ({ ...t, clips: [...t.clips, copy] }), copy.id)
    }

    case 'DELETE_CLIP': {
      const session = mapTrack(state.session, action.trackId, (t) => ({ ...t, clips: t.clips.filter((c) => c.id !== action.clipId) }))
      const selectedClipId = state.selectedClipId === action.clipId ? null : state.selectedClipId
      return { ...state, session, selectedClipId }
    }

    case 'SET_CLIP_GAIN':
      return { ...state, session: mapClip(state.session, action.trackId, action.clipId, (c) => ({ ...c, gainDb: clampNumber(action.gainDb, GAIN_DB_MIN, GAIN_DB_MAX, c.gainDb) })) }

    case 'SET_CLIP_FADES':
      return { ...state, session: mapClip(state.session, action.trackId, action.clipId, (c) => ({ ...c, fades: { ...c.fades, ...action.fades } })) }

    case 'SET_MASTER':
      return { ...state, session: { ...state.session, master: sanitizeMaster({ ...state.session.master, ...action.patch }) } }

    case 'RENAME_SESSION':
      return { ...state, session: { ...state.session, name: sanitizeName(action.name, state.session.name) } }

    case 'LOAD_SESSION':
    case 'NEW_SESSION':
      return adoptSession(state, action.session)

    case 'SET_STATUS':
      return { ...state, status: action.status }

    default:
      return assertNever(action)
  }
}

/** Apply a track transform and select the freshly-added clip id. */
function mapTrackReturn(state: AppState, trackId: string, fn: (t: Track) => Track, selectClipId: string): AppState {
  const session = mapTrack(state.session, trackId, fn)
  if (session === state.session) return state // track not found → no-op, no selection change
  return { ...state, session, selectedTrackId: trackId, selectedClipId: selectClipId }
}

function findClip(session: Session, trackId: string, clipId: string): Clip | undefined {
  return session.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId)
}

/** Exhaustiveness guard: a new Action variant that isn't handled fails to compile. */
function assertNever(_action: never): never {
  throw new Error('mtape reducer: unhandled action')
}
