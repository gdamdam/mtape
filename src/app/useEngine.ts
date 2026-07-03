// mtape — the bridge between the pure reducer world and the imperative audio
// engine. The UI never imports Web Audio directly; it calls the `controls`
// object this hook returns, and the hook pushes declarative session state down
// to one `EngineControls` and fans engine events back up (mostly into refs, so
// the 30–60 Hz position/meter stream never re-renders React).
//
// The engine is injectable: tests pass a `createEngine` that returns the mock,
// so nothing here ever touches a real AudioContext under test. The real engine
// is imported lazily (dynamic import) so a missing AudioEngine.ts during the
// parallel build can't break the reducer/UI test suites.

import { useCallback, useEffect, useMemo, useRef, type Dispatch, type RefObject } from 'react'
import type { Action, AppState } from './state'
import type { DecodedAudio, EngineControls } from '../audio/engineApi'
import type { EngineEvent, TrackArrangement } from '../audio/messages'
import { compensateRecordStart } from '../transport/timing'
import { clipEndSec } from '../clips/clipMath'
import { renderSession, type SourceMap } from '../render/renderSession'
import { encodeWav, type BitDepth } from '../recording/wav'
import { getAudio, getSession, putAudio, putSession } from '../persistence/db'
import { saveLastSessionId } from '../persistence/lastSession'
import { exportSession, parseImport, serializeExport } from '../persistence/exportImport'
import { decodeSessionLink, encodeSessionLink } from '../sharing/sessionLink'
import { defaultSession, type Clip, type Session, type Track, type TrackInputKind } from '../audio/contracts'

/** Latest meter frame, mirrored from the engine's `meters` event. */
export interface MeterSnapshot {
  masterPeakL: number
  masterPeakR: number
  masterRms: number
  clip: boolean
  tracks: Record<string, { peak: number; rms: number }>
}

export type MixdownRegion = 'song' | 'loop'

/** The stable imperative surface the UI calls. */
export interface UiControls {
  start(): Promise<void>
  play(): void
  stop(): void
  record(): void
  seek(sec: number): void
  armTrack(trackId: string): void
  chooseInput(trackId: string, kind: TrackInputKind): Promise<void>
  importFile(trackId: string, file: File): Promise<void>
  mixdown(opts: { region: MixdownRegion; bitDepth?: BitDepth }): Promise<void>
  exportStems(bitDepth?: BitDepth): Promise<void>
  saveSession(): Promise<void>
  loadSession(id: string): Promise<void>
  newSession(): void
  exportJson(): void
  importJson(file: File): Promise<void>
  copyShareLink(): Promise<void>
}

export interface UseEngineOptions {
  /** Injected factory (tests pass the mock); defaults to the real engine. */
  createEngine?: () => EngineControls
}

export interface UseEngineResult {
  controls: UiControls
  posRef: RefObject<number>
  meterRef: RefObject<MeterSnapshot | null>
}

// --- pure-ish helpers ------------------------------------------------------

/** Non-crypto fallback keeps id minting total in exotic embeddings. */
function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Project the persisted tracks into the flat arrangement the worklet wants. */
function toArrangement(tracks: Track[]): TrackArrangement[] {
  return tracks.map((t) => ({
    trackId: t.id,
    gainDb: t.gainDb,
    pan: t.pan,
    mute: t.mute,
    solo: t.solo,
    armed: t.armed,
    monitor: t.monitor,
    eq: t.eq,
    tape: t.tape,
    clips: t.clips.map((c) => ({
      clipId: c.id,
      audioId: c.audioId,
      startSec: c.startSec,
      offsetSec: c.offsetSec,
      durationSec: c.durationSec,
      gainDb: c.gainDb,
      fadeInSec: c.fades.inSec,
      fadeOutSec: c.fades.outSec,
    })),
  }))
}

/** End of the last-sounding clip across all tracks — the song's natural length. */
function songEndSec(session: Session): number {
  let end = 0
  for (const t of session.tracks) for (const c of t.clips) end = Math.max(end, clipEndSec(c))
  return end
}

function triggerDownload(filename: string, blob: Blob): void {
  if (typeof document === 'undefined') return
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke after the click has been serviced; immediate revoke can race Safari.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function useEngine(dispatch: Dispatch<Action>, stateRef: RefObject<AppState>, opts?: UseEngineOptions): UseEngineResult {
  const posRef = useRef(0)
  const meterRef = useRef<MeterSnapshot | null>(null)
  const engineRef = useRef<EngineControls | null>(null)
  const offRef = useRef<() => void>(() => {})
  const audioCtxRef = useRef<AudioContext | null>(null)
  // Decoded sources kept in RAM for instant re-use by mixdown; falls back to
  // re-decoding the stored blob from IndexedDB on a miss.
  const sourceCacheRef = useRef<Map<string, DecodedAudio>>(new Map())
  // recordChunk payloads accumulate here per audioId until recordComplete.
  const recChunksRef = useRef<Map<string, Float32Array[][]>>(new Map())

  // Read latest state each render; the ref is refreshed by App before this runs,
  // so these values are current and safe as effect dependencies.
  const { session, audioReady } = stateRef.current

  // Keep the injected factory in a ref so `ensureEngine` stays referentially
  // stable (opts is often a fresh object every render).
  const createEngineRef = useRef(opts?.createEngine)
  createEngineRef.current = opts?.createEngine

  function getAudioContext(): AudioContext | null {
    if (audioCtxRef.current) return audioCtxRef.current
    const Ctor = typeof window !== 'undefined' ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) : undefined
    if (!Ctor) return null
    audioCtxRef.current = new Ctor()
    return audioCtxRef.current
  }

  async function decodeFile(file: File): Promise<DecodedAudio> {
    const ctx = getAudioContext()
    if (!ctx) throw new Error('Web Audio is unavailable in this environment.')
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer())
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => Float32Array.from(buffer.getChannelData(c)))
    return { audioId: newId(), channels, sampleRate: buffer.sampleRate, durationSec: buffer.duration }
  }

  /** Assemble a SourceMap for renderSession from cache, re-decoding on a miss. */
  const gatherSources = useCallback(async (s: Session): Promise<SourceMap> => {
    const map: SourceMap = new Map()
    const ids = new Set<string>()
    for (const t of s.tracks) for (const c of t.clips) ids.add(c.audioId)
    for (const id of ids) {
      const cached = sourceCacheRef.current.get(id)
      if (cached) {
        map.set(id, { channels: cached.channels, sampleRate: cached.sampleRate })
        continue
      }
      // Missing from RAM — try to rehydrate the original blob. A still-missing
      // asset (e.g. a shared link) is simply left out: renderSession renders it
      // as silence, matching the hatched placeholder shown in the timeline.
      try {
        const blob = await getAudio(id)
        const ctx = getAudioContext()
        if (blob && ctx) {
          const buffer = await ctx.decodeAudioData(await blob.arrayBuffer())
          const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => Float32Array.from(buffer.getChannelData(c)))
          const decoded: DecodedAudio = { audioId: id, channels, sampleRate: buffer.sampleRate, durationSec: buffer.duration }
          sourceCacheRef.current.set(id, decoded)
          map.set(id, { channels, sampleRate: buffer.sampleRate })
        }
      } catch {
        // Leave silent.
      }
    }
    return map
  }, [])

  // Persist the working session; the impure timestamp lives here, not in pure code.
  const persist = useCallback(async (s: Session): Promise<void> => {
    const now = Date.now()
    try {
      await putSession({ ...s, createdAt: s.createdAt || now, updatedAt: now })
      saveLastSessionId(s.id)
    } catch {
      // Storage full/disabled (private mode) — autosave is best-effort.
    }
  }, [])

  // Finalize a completed take: encode the accumulated PCM to a WAV blob for
  // durability, cache + load it, then drop a clip on the armed track at the
  // latency-compensated position. recordComplete carries no samples of its own,
  // so we rely on the recordChunk stream we buffered (see note in report).
  const finalizeRecording = useCallback(
    async (ev: Extract<EngineEvent, { type: 'recordComplete' }>): Promise<void> => {
      const chunks = recChunksRef.current.get(ev.audioId) ?? []
      recChunksRef.current.delete(ev.audioId)
      const sampleRate = audioCtxRef.current?.sampleRate ?? 48000
      const nCh = chunks[0]?.length ?? 0
      if (nCh > 0) {
        const channels = Array.from({ length: nCh }, (_, c) => {
          const total = chunks.reduce((n, frame) => n + frame[c].length, 0)
          const out = new Float32Array(total)
          let o = 0
          for (const frame of chunks) {
            out.set(frame[c], o)
            o += frame[c].length
          }
          return out
        })
        const decoded: DecodedAudio = { audioId: ev.audioId, channels, sampleRate, durationSec: channels[0].length / sampleRate }
        sourceCacheRef.current.set(ev.audioId, decoded)
        engineRef.current?.loadAudio(decoded)
        try {
          await putAudio(ev.audioId, new Blob([encodeWav(channels, { sampleRate })], { type: 'audio/wav' }))
        } catch {
          // Non-fatal: the take still plays from the in-memory cache this session.
        }
      }
      const latency = engineRef.current?.latencySec() ?? 0
      const clip: Clip = {
        id: newId(),
        audioId: ev.audioId,
        startSec: compensateRecordStart(ev.startSec, latency),
        offsetSec: 0,
        durationSec: ev.durationSec,
        gainDb: 0,
        fades: { inSec: 0, outSec: 0 },
      }
      dispatch({ type: 'ADD_CLIP', trackId: ev.trackId, clip })
    },
    [dispatch],
  )

  const handleEvent = useCallback(
    (event: EngineEvent): void => {
      switch (event.type) {
        case 'position':
          // Hot path: refs only, never a dispatch.
          posRef.current = event.positionSec
          break
        case 'meters': {
          const tracks: MeterSnapshot['tracks'] = {}
          for (const t of event.tracks) tracks[t.trackId] = { peak: t.peak, rms: t.rms }
          meterRef.current = { masterPeakL: event.masterPeakL, masterPeakR: event.masterPeakR, masterRms: event.masterRms, clip: event.clip, tracks }
          break
        }
        case 'recordChunk': {
          const list = recChunksRef.current.get(event.audioId) ?? []
          list.push(event.channels)
          recChunksRef.current.set(event.audioId, list)
          break
        }
        case 'recordComplete':
          void finalizeRecording(event)
          break
        case 'ended':
          dispatch({ type: 'SET_TRANSPORT', playing: false, recording: false })
          break
      }
    },
    [dispatch, finalizeRecording],
  )

  const ensureEngine = useCallback(async (): Promise<EngineControls> => {
    if (engineRef.current) return engineRef.current
    const factory = createEngineRef.current ?? (await import('../audio/AudioEngine')).createEngine
    const engine = factory()
    offRef.current = engine.onEvent(handleEvent)
    engineRef.current = engine
    return engine
  }, [handleEvent])

  // Tear down on unmount.
  useEffect(() => {
    return () => {
      offRef.current()
      engineRef.current?.dispose()
      engineRef.current = null
      audioCtxRef.current?.close().catch(() => {})
      audioCtxRef.current = null
    }
  }, [])

  // Push declarative state whenever the session changes (once audio is live).
  useEffect(() => {
    const e = engineRef.current
    if (!e || !audioReady) return
    e.setTempo(session.tempo)
    e.setLoop(session.loop)
    e.setMetronome(session.metronome, session.countInBars)
    e.setMaster(session.master)
    e.setArrangement(toArrangement(session.tracks))
  }, [session, audioReady])

  // Debounced autosave of the working session.
  useEffect(() => {
    const t = setTimeout(() => {
      void persist(session)
    }, 600)
    return () => clearTimeout(t)
  }, [session, persist])

  // First-mount session bootstrap: shared link > last session > default.
  useEffect(() => {
    let cancelled = false
    async function boot(): Promise<void> {
      const hash = typeof location !== 'undefined' ? location.hash : ''
      if (hash && hash.length > 1) {
        const shared = decodeSessionLink(hash)
        if (shared && !cancelled) {
          dispatch({ type: 'LOAD_SESSION', session: shared })
          dispatch({ type: 'SET_STATUS', status: 'Opened a shared arrangement — audio is not included in a link.' })
          return
        }
      }
      // No effort to load "last session" list here; the SessionBar drives explicit
      // opens. A default session was already created by App's initialState.
    }
    void boot()
    return () => {
      cancelled = true
    }
  }, [dispatch])

  const controls = useMemo<UiControls>(() => {
    return {
      async start() {
        const e = await ensureEngine()
        await e.start()
        dispatch({ type: 'SET_AUDIO_READY', ready: true })
      },
      play() {
        engineRef.current?.play()
        dispatch({ type: 'SET_TRANSPORT', playing: true, recording: false })
      },
      stop() {
        engineRef.current?.stop()
        dispatch({ type: 'SET_TRANSPORT', playing: false, recording: false })
      },
      record() {
        engineRef.current?.record()
        dispatch({ type: 'SET_TRANSPORT', playing: true, recording: true })
      },
      seek(sec: number) {
        posRef.current = sec
        engineRef.current?.seek(sec)
      },
      armTrack(trackId: string) {
        dispatch({ type: 'SET_TRACK_PARAM', trackId, patch: { armed: true } })
      },
      async chooseInput(trackId: string, kind: TrackInputKind) {
        dispatch({ type: 'SET_TRACK_PARAM', trackId, patch: { input: kind } })
        const e = engineRef.current
        if (!e) return
        if (kind === 'none') {
          e.detachInput(trackId)
          return
        }
        if (kind === 'file') return // file input is driven by importFile + a picker
        try {
          const stream = kind === 'tab' ? await e.captureTab() : await e.captureMic()
          e.attachInput(trackId, stream)
        } catch {
          dispatch({ type: 'SET_STATUS', status: kind === 'tab' ? 'Tab capture is Chromium-desktop only.' : 'Microphone access was blocked.' })
          dispatch({ type: 'SET_TRACK_PARAM', trackId, patch: { input: 'none' } })
        }
      },
      async importFile(trackId: string, file: File) {
        try {
          const decoded = await decodeFile(file)
          sourceCacheRef.current.set(decoded.audioId, decoded)
          engineRef.current?.loadAudio(decoded)
          try {
            await putAudio(decoded.audioId, file)
          } catch {
            // Persist failure is non-fatal for this session.
          }
          const clip: Clip = {
            id: newId(),
            audioId: decoded.audioId,
            name: file.name,
            startSec: posRef.current,
            offsetSec: 0,
            durationSec: decoded.durationSec,
            gainDb: 0,
            fades: { inSec: 0, outSec: 0 },
          }
          dispatch({ type: 'ADD_CLIP', trackId, clip })
        } catch {
          dispatch({ type: 'SET_STATUS', status: 'Could not decode that audio file.' })
        }
      },
      async mixdown({ region, bitDepth = 16 }) {
        const s = stateRef.current.session
        const startSec = region === 'loop' && s.loop.enabled ? s.loop.startSec : 0
        const endSec = region === 'loop' && s.loop.enabled ? s.loop.endSec : songEndSec(s)
        if (endSec <= startSec) {
          dispatch({ type: 'SET_STATUS', status: 'Nothing to mix down yet — record or import a clip first.' })
          return
        }
        const sources = await gatherSources(s)
        const sampleRate = [...sources.values()][0]?.sampleRate ?? 44100
        const result = renderSession(s, sources, { sampleRate, startSec, endSec, channels: 2 })
        triggerDownload(`${s.name || 'mtape'}.wav`, new Blob([encodeWav(result.channels, { sampleRate, bitDepth })], { type: 'audio/wav' }))
      },
      async exportStems(bitDepth = 16) {
        const s = stateRef.current.session
        const endSec = songEndSec(s)
        if (endSec <= 0) {
          dispatch({ type: 'SET_STATUS', status: 'Nothing to export yet.' })
          return
        }
        const sources = await gatherSources(s)
        const sampleRate = [...sources.values()][0]?.sampleRate ?? 44100
        for (const track of s.tracks) {
          if (track.clips.length === 0) continue
          // Render this track in isolation by soloing it exclusively.
          const solo: Session = { ...s, tracks: s.tracks.map((t) => ({ ...t, solo: t.id === track.id })) }
          const result = renderSession(solo, sources, { sampleRate, startSec: 0, endSec, channels: 2 })
          triggerDownload(`${s.name || 'mtape'} - ${track.name}.wav`, new Blob([encodeWav(result.channels, { sampleRate, bitDepth })], { type: 'audio/wav' }))
        }
      },
      async saveSession() {
        await persist(stateRef.current.session)
        dispatch({ type: 'SET_STATUS', status: 'Session saved.' })
      },
      async loadSession(id: string) {
        try {
          const loaded = await getSession(id)
          if (loaded) dispatch({ type: 'LOAD_SESSION', session: loaded })
        } catch {
          dispatch({ type: 'SET_STATUS', status: 'Could not open that session.' })
        }
      },
      newSession() {
        dispatch({ type: 'NEW_SESSION', session: defaultSession(newId()) })
      },
      exportJson() {
        const s = stateRef.current.session
        triggerDownload(`${s.name || 'mtape'}.mtape.json`, new Blob([serializeExport(exportSession(s))], { type: 'application/json' }))
      },
      async importJson(file: File) {
        try {
          const session = parseImport(await file.text())
          dispatch({ type: 'LOAD_SESSION', session })
          dispatch({ type: 'SET_STATUS', status: 'Imported arrangement — link/JSON does not carry the audio blobs.' })
        } catch (err) {
          dispatch({ type: 'SET_STATUS', status: err instanceof Error ? err.message : 'Could not import that file.' })
        }
      },
      async copyShareLink() {
        const token = encodeSessionLink(stateRef.current.session)
        if (typeof location !== 'undefined') location.hash = token
        try {
          const url = typeof location !== 'undefined' ? `${location.origin}${location.pathname}#${token}` : token
          await navigator.clipboard?.writeText(url)
          dispatch({ type: 'SET_STATUS', status: 'Share link copied to the clipboard.' })
        } catch {
          dispatch({ type: 'SET_STATUS', status: 'Share link is in the address bar (clipboard was blocked).' })
        }
      },
    }
    // stateRef/posRef/etc are stable refs; dispatch/ensureEngine/gatherSources/persist are memoized.
  }, [dispatch, ensureEngine, gatherSources, persist, stateRef])

  return { controls, posRef, meterRef }
}
