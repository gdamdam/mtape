// mtape — UI ↔ AudioWorklet message contracts.
//
// Two discriminated unions cross the port boundary: EngineCommand (main → worklet)
// and EngineEvent (worklet → main). Heavy sample payloads travel as transferable
// ArrayBuffers. Every command is validated by `sanitizeCommand` before it reaches
// the DSP loop — the worklet message handler is a trust boundary just like
// storage and URL fragments.

import {
  clampNumber,
  coerceBool,
  sanitizeLoop,
  sanitizeMaster,
  sanitizeEq,
  sanitizeTape,
  type LoopRegion,
  type MasterBus,
  type ThreeBandEq,
  type TapeCharacter,
  PAN_MIN,
  PAN_MAX,
  GAIN_DB_MIN,
  GAIN_DB_MAX,
  TEMPO_MIN,
  TEMPO_MAX,
  COUNT_IN_BARS_MAX,
  TIMELINE_SEC_MAX,
  CLIP_SEC_MAX,
} from './contracts'

// --------------------------------------------------------------------------
// Arrangement view sent to the worklet — the placement of clips on tracks,
// referencing audio by id. Decoupled from the persisted Session so the worklet
// only carries what the scheduler needs.
// --------------------------------------------------------------------------

export interface ClipPlacement {
  clipId: string
  audioId: string
  startSec: number
  offsetSec: number
  durationSec: number
  gainDb: number
  fadeInSec: number
  fadeOutSec: number
}

export interface TrackArrangement {
  trackId: string
  gainDb: number
  pan: number
  mute: boolean
  solo: boolean
  armed: boolean
  monitor: boolean
  eq: ThreeBandEq
  tape: TapeCharacter
  clips: ClipPlacement[]
}

// --------------------------------------------------------------------------
// Commands: main → worklet
// --------------------------------------------------------------------------

export type TransportAction = 'play' | 'stop' | 'record'

export type EngineCommand =
  | { type: 'transport'; action: TransportAction }
  | { type: 'seek'; positionSec: number }
  | { type: 'setTempo'; tempo: number }
  | { type: 'setLoop'; loop: LoopRegion }
  | { type: 'setMetronome'; enabled: boolean; countInBars: number }
  | { type: 'setMaster'; master: MasterBus }
  | { type: 'setArrangement'; tracks: TrackArrangement[] }
  | { type: 'loadAudio'; audioId: string; channels: Float32Array[]; sampleRate: number }
  | { type: 'unloadAudio'; audioId: string }
  | { type: 'setLatency'; latencySec: number }

// --------------------------------------------------------------------------
// Events: worklet → main
// --------------------------------------------------------------------------

export interface TrackMeter {
  trackId: string
  peak: number
  rms: number
}

export type EngineEvent =
  | { type: 'position'; positionSec: number; playing: boolean; recording: boolean }
  | { type: 'meters'; masterPeakL: number; masterPeakR: number; masterRms: number; clip: boolean; tracks: TrackMeter[] }
  | { type: 'recordChunk'; trackId: string; audioId: string; channels: Float32Array[]; startFrame: number }
  | { type: 'recordComplete'; trackId: string; audioId: string; startSec: number; durationSec: number }
  | { type: 'ended' }

// --------------------------------------------------------------------------
// Validation. sanitizeCommand returns a valid command or null (drop it).
// --------------------------------------------------------------------------

const TRANSPORT_ACTIONS: readonly TransportAction[] = ['play', 'stop', 'record']

function sanitizeClipPlacement(value: unknown): ClipPlacement | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Partial<ClipPlacement>
  if (typeof v.audioId !== 'string' || v.audioId.length === 0) return null
  const durationSec = clampNumber(v.durationSec, 0, CLIP_SEC_MAX, 0)
  return {
    clipId: typeof v.clipId === 'string' ? v.clipId.slice(0, 128) : v.audioId,
    audioId: v.audioId.slice(0, 128),
    startSec: clampNumber(v.startSec, 0, TIMELINE_SEC_MAX, 0),
    offsetSec: clampNumber(v.offsetSec, 0, CLIP_SEC_MAX, 0),
    durationSec,
    gainDb: clampNumber(v.gainDb, GAIN_DB_MIN, GAIN_DB_MAX, 0),
    fadeInSec: clampNumber(v.fadeInSec, 0, durationSec, 0),
    fadeOutSec: clampNumber(v.fadeOutSec, 0, durationSec, 0),
  }
}

function sanitizeTrackArrangement(value: unknown): TrackArrangement | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Partial<TrackArrangement>
  if (typeof v.trackId !== 'string' || v.trackId.length === 0) return null
  const clips = Array.isArray(v.clips)
    ? v.clips.map(sanitizeClipPlacement).filter((c): c is ClipPlacement => c !== null)
    : []
  return {
    trackId: v.trackId.slice(0, 128),
    gainDb: clampNumber(v.gainDb, GAIN_DB_MIN, GAIN_DB_MAX, 0),
    pan: clampNumber(v.pan, PAN_MIN, PAN_MAX, 0),
    mute: coerceBool(v.mute, false),
    solo: coerceBool(v.solo, false),
    armed: coerceBool(v.armed, false),
    monitor: coerceBool(v.monitor, false),
    eq: sanitizeEq(v.eq),
    tape: sanitizeTape(v.tape),
    clips,
  }
}

/** Validate an inbound command. Returns a clamped copy, or null to drop it. */
export function sanitizeCommand(value: unknown): EngineCommand | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as { type?: unknown } & Record<string, unknown>
  switch (v.type) {
    case 'transport': {
      const action = v.action
      if (typeof action !== 'string' || !TRANSPORT_ACTIONS.includes(action as TransportAction)) return null
      return { type: 'transport', action: action as TransportAction }
    }
    case 'seek':
      return { type: 'seek', positionSec: clampNumber(v.positionSec, 0, TIMELINE_SEC_MAX, 0) }
    case 'setTempo':
      return { type: 'setTempo', tempo: clampNumber(v.tempo, TEMPO_MIN, TEMPO_MAX, 120) }
    case 'setLoop':
      return { type: 'setLoop', loop: sanitizeLoop(v.loop) }
    case 'setMetronome':
      return {
        type: 'setMetronome',
        enabled: coerceBool(v.enabled, false),
        countInBars: clampNumber(v.countInBars, 0, COUNT_IN_BARS_MAX, 0),
      }
    case 'setMaster':
      return { type: 'setMaster', master: sanitizeMaster(v.master) }
    case 'setArrangement': {
      const tracks = Array.isArray(v.tracks)
        ? v.tracks.map(sanitizeTrackArrangement).filter((t): t is TrackArrangement => t !== null)
        : []
      return { type: 'setArrangement', tracks }
    }
    case 'loadAudio': {
      if (typeof v.audioId !== 'string' || v.audioId.length === 0) return null
      if (!Array.isArray(v.channels)) return null
      const channels = v.channels.filter((c): c is Float32Array => c instanceof Float32Array)
      if (channels.length === 0) return null
      return {
        type: 'loadAudio',
        audioId: v.audioId.slice(0, 128),
        channels,
        sampleRate: clampNumber(v.sampleRate, 1, 768000, 48000),
      }
    }
    case 'unloadAudio':
      if (typeof v.audioId !== 'string' || v.audioId.length === 0) return null
      return { type: 'unloadAudio', audioId: v.audioId.slice(0, 128) }
    case 'setLatency':
      return { type: 'setLatency', latencySec: clampNumber(v.latencySec, 0, 2, 0) }
    default:
      return null
  }
}
