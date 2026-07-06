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

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type RefObject } from 'react'
import type { Action, AppState } from './state'
import type { DecodedAudio, EngineControls } from '../audio/engineApi'
import type { EngineEvent, TrackArrangement } from '../audio/messages'
import { clipEndSec } from '../clips/clipMath'
import { renderSession, type SourceMap } from '../render/renderSession'
import { encodeWav, type BitDepth } from '../recording/wav'
import { getAudio, getSession, putAudio, putSession } from '../persistence/db'
import { saveLastSessionId } from '../persistence/lastSession'
import { exportSession, parseImport, serializeExport } from '../persistence/exportImport'
import { decodeSessionLink, encodeSessionLink } from '../sharing/sessionLink'
import { defaultSession, type Clip, type Session, type Track, type TrackInputKind } from '../audio/contracts'
import { createMbusClient, type MbusClient, type Publication, type SourceInfo, type Subscription } from '../transport/mbus'

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
  /** Offer (or withdraw) the master mix as an mbus source named 'mtape'.
   *  Off by default and session-transient; harmless without the bridge. */
  setMbusPublish(on: boolean): void
  /** Subscribe a track's mbus input to a published sibling source ('' = none).
   *  The track's input kind must be 'mbus' (chooseInput). */
  chooseMbusSource(trackId: string, sourceId: string): void
}

export interface UseEngineOptions {
  /** Injected factory (tests pass the mock); defaults to the real engine. */
  createEngine?: () => EngineControls
}

export interface UseEngineResult {
  controls: UiControls
  posRef: RefObject<number>
  meterRef: RefObject<MeterSnapshot | null>
  /** Advertised mbus sources (live directory; empty without the bridge). */
  mbusSources: SourceInfo[]
  /** Per-track subscribed mbus sourceId (session-transient). */
  mbusChoices: Record<string, string>
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
  // audioIds already pushed into the live engine, so the rehydration effect and
  // the import/record paths don't double-load (or reload after a session swap). (H4)
  const loadedAudioRef = useRef<Set<string>>(new Set())
  // In-flight engine-creation promise, so two rapid start() calls share one
  // engine instead of racing to build two (the first would leak). (M12)
  const enginePromiseRef = useRef<Promise<EngineControls> | null>(null)
  // mbus publish (see src/transport/mbus): intent + client/publication, kept in
  // refs like the engine itself. Off by default; until enabled no client exists
  // and no socket is opened. applyMbusPublish reconciles intent with the live
  // engine so toggle-before-start and engine restarts both resolve correctly.
  const mbusClientRef = useRef<MbusClient | null>(null)
  const mbusPubRef = useRef<Publication | null>(null)
  const mbusTapRef = useRef<AudioNode | null>(null)
  const mbusWantedRef = useRef(false)
  // mbus INPUT side: per-track subscriptions bridged into the engine's
  // MediaStream input plumbing via a MediaStreamDestination. The client is
  // shared with the publish side; discovery stays on once a track has used the
  // mbus input (cheap idle localhost socket, mfx precedent).
  const mbusInputsRef = useRef(new Map<string, { sub: Subscription; dest: MediaStreamAudioDestinationNode }>())
  const mbusDiscoveryRef = useRef(false)
  const mbusSourcesOffRef = useRef<(() => void) | null>(null)
  const [mbusSources, setMbusSources] = useState<SourceInfo[]>([])
  const [mbusChoices, setMbusChoices] = useState<Record<string, string>>({})
  // Signatures of the last declarative state pushed to the engine, so an
  // unrelated dispatch (e.g. a per-pointermove MOVE_CLIP drag frame) doesn't
  // re-post unchanged tempo/loop/master/arrangement to the worklet. (L12)
  const lastPushRef = useRef<{ tempo?: number; loop?: string; metro?: string; master?: string; arr?: string }>({})

  // Read latest state each render; the ref is refreshed by App before this runs,
  // so these values are current and safe as effect dependencies.
  const { session, audioReady } = stateRef.current

  // The pristine session at mount. Autosave is skipped while the working session
  // is still this exact reference (no user edit / no load has happened), so a
  // fresh empty default isn't persisted on every page load / share-link view. (M11)
  const initialSessionRef = useRef(session)

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

  /**
   * Push a decoded asset into the live engine. `loadAudio` TRANSFERS (detaches)
   * the channel buffers it is handed, so we give it a fresh copy and keep our
   * originals intact for WAV encoding, the source cache, and offline render —
   * otherwise the caller's arrays zero out and takes persist as empty WAVs. (H1)
   */
  const loadIntoEngine = useCallback((decoded: DecodedAudio): void => {
    const e = engineRef.current
    if (!e) return
    e.loadAudio({ ...decoded, channels: decoded.channels.map((c) => c.slice()) })
    loadedAudioRef.current.add(decoded.audioId)
  }, [])

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
        // Sample rate of the ENGINE's capture context. The decode-only
        // audioCtxRef may be a different rate or absent on a record-first flow,
        // so derive the true rate from the take's own frame count and reported
        // duration (worklet: durationSec = frames / captureRate). (H3)
        const frames = channels[0].length
        const sampleRate = ev.durationSec > 0 ? Math.round(frames / ev.durationSec) : (audioCtxRef.current?.sampleRate ?? 48000)
        const decoded: DecodedAudio = { audioId: ev.audioId, channels, sampleRate, durationSec: frames / sampleRate }
        sourceCacheRef.current.set(ev.audioId, decoded)
        loadIntoEngine(decoded) // copies channels; `channels` below stays intact (H1)
        try {
          await putAudio(ev.audioId, new Blob([encodeWav(channels, { sampleRate })], { type: 'audio/wav' }))
        } catch {
          // Non-fatal: the take still plays from the in-memory cache this session.
        }
      }
      const clip: Clip = {
        id: newId(),
        audioId: ev.audioId,
        // ev.startSec is ALREADY latency-compensated by AudioEngine.handleEvent;
        // compensating again here landed every take 2× latency early. (H2)
        startSec: ev.startSec,
        offsetSec: 0,
        durationSec: ev.durationSec,
        gainDb: 0,
        fades: { inSec: 0, outSec: 0 },
      }
      dispatch({ type: 'ADD_CLIP', trackId: ev.trackId, clip })
    },
    [dispatch, loadIntoEngine],
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

  // Reconcile the mbus publish intent with the live engine: enable is deferred
  // until the engine exists (start() re-applies); disable unannounces the
  // source and drops the bridge socket so "off" leaves nothing running.
  const applyMbusPublish = useCallback(() => {
    const tap = engineRef.current?.getMasterTap() ?? null
    const wanted = mbusWantedRef.current
    if (mbusPubRef.current && (mbusTapRef.current !== tap || !wanted)) {
      mbusPubRef.current.stop()
      mbusPubRef.current = null
      mbusTapRef.current = null
    }
    if (wanted && tap && !mbusPubRef.current) {
      mbusClientRef.current ??= createMbusClient()
      mbusClientRef.current.connect()
      mbusPubRef.current = mbusClientRef.current.publishOutput(tap, 'mtape')
      mbusTapRef.current = tap
    }
    // The client is shared with the mbus input side — only drop the socket
    // when nothing needs it anymore.
    if (!wanted && !mbusDiscoveryRef.current && mbusInputsRef.current.size === 0) {
      mbusClientRef.current?.disconnect()
    }
  }, [])

  /** Create/connect the shared client and start directory discovery. */
  const ensureMbusClient = useCallback((): MbusClient => {
    mbusClientRef.current ??= createMbusClient()
    const client = mbusClientRef.current
    if (!mbusSourcesOffRef.current) {
      mbusSourcesOffRef.current = client.onSources((s) => setMbusSources([...s]))
    }
    mbusDiscoveryRef.current = true
    client.connect()
    return client
  }, [])

  /** Close a track's mbus subscription (idempotent). */
  const closeMbusInput = useCallback((trackId: string) => {
    const h = mbusInputsRef.current.get(trackId)
    if (!h) return
    mbusInputsRef.current.delete(trackId)
    try {
      h.sub.close()
      h.dest.disconnect()
    } catch {
      /* graph may already be gone */
    }
    setMbusChoices((prev) => {
      const next = { ...prev }
      delete next[trackId]
      return next
    })
  }, [])

  const ensureEngine = useCallback(async (): Promise<EngineControls> => {
    if (engineRef.current) return engineRef.current
    // Reuse an in-flight build so concurrent start() calls don't each await the
    // dynamic import and construct a second engine (the first would leak). (M12)
    if (enginePromiseRef.current) return enginePromiseRef.current
    const p = (async (): Promise<EngineControls> => {
      const factory = createEngineRef.current ?? (await import('../audio/AudioEngine')).createEngine
      const engine = factory()
      offRef.current = engine.onEvent(handleEvent)
      engineRef.current = engine
      return engine
    })()
    // Clear the memo on failure so a later start() can retry the import.
    p.catch(() => {
      enginePromiseRef.current = null
    })
    enginePromiseRef.current = p
    return p
  }, [handleEvent])

  // Tear down on unmount.
  useEffect(() => {
    return () => {
      offRef.current()
      engineRef.current?.dispose()
      engineRef.current = null
      enginePromiseRef.current = null
      audioCtxRef.current?.close().catch(() => {})
      audioCtxRef.current = null
    }
  }, [])

  // Push declarative state whenever the session changes (once audio is live).
  // Each piece is diffed against the last value sent so a drag's per-frame
  // MOVE_CLIP dispatch doesn't re-post unchanged tempo/loop/master — and doesn't
  // re-post the whole arrangement when nothing in it actually changed. (L12)
  useEffect(() => {
    const e = engineRef.current
    if (!e || !audioReady) return
    const p = lastPushRef.current
    if (p.tempo !== session.tempo) {
      e.setTempo(session.tempo)
      p.tempo = session.tempo
    }
    const loopKey = JSON.stringify(session.loop)
    if (p.loop !== loopKey) {
      e.setLoop(session.loop)
      p.loop = loopKey
    }
    const metroKey = `${session.metronome}:${session.countInBars}`
    if (p.metro !== metroKey) {
      e.setMetronome(session.metronome, session.countInBars)
      p.metro = metroKey
    }
    const masterKey = JSON.stringify(session.master)
    if (p.master !== masterKey) {
      e.setMaster(session.master)
      p.master = masterKey
    }
    const arr = toArrangement(session.tracks)
    const arrKey = JSON.stringify(arr)
    if (p.arr !== arrKey) {
      e.setArrangement(arr)
      p.arr = arrKey
    }
  }, [session, audioReady])

  // Rehydrate engine audio for the current session: LOAD_SESSION (Open / import /
  // share-link) pushes clip placements but the samples live in IndexedDB, so
  // without this a reloaded/opened session plays total silence. Decode each
  // referenced blob not already loaded and hand it to the engine. (H4)
  useEffect(() => {
    const e = engineRef.current
    if (!e || !audioReady) return
    let cancelled = false
    const ids = new Set<string>()
    for (const t of session.tracks) for (const c of t.clips) ids.add(c.audioId)
    void (async () => {
      for (const id of ids) {
        if (loadedAudioRef.current.has(id)) continue
        const cached = sourceCacheRef.current.get(id)
        if (cached) {
          loadIntoEngine(cached) // already in RAM this session; just push it
          continue
        }
        try {
          const blob = await getAudio(id)
          const ctx = getAudioContext()
          if (!blob || !ctx || cancelled) continue
          const buffer = await ctx.decodeAudioData(await blob.arrayBuffer())
          const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => Float32Array.from(buffer.getChannelData(c)))
          const decoded: DecodedAudio = { audioId: id, channels, sampleRate: buffer.sampleRate, durationSec: buffer.duration }
          sourceCacheRef.current.set(id, decoded)
          if (cancelled) continue
          loadIntoEngine(decoded)
        } catch {
          // Leave silent — matches the missing-audio placeholder in the timeline.
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [session, audioReady, loadIntoEngine])

  // Debounced autosave of the working session. Skipped while the session is the
  // untouched mount-time default (no edit / load has produced a new reference),
  // so a fresh empty session isn't persisted on every page load or link view. (M11)
  useEffect(() => {
    if (session === initialSessionRef.current) return
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
          // Mint a fresh id so this decoded arrangement is a "copy of" — autosave
          // must not clobber the newer stored session that shares the link's id. (H9)
          dispatch({ type: 'LOAD_SESSION', session: { ...shared, id: newId() } })
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
        let e: EngineControls
        try {
          e = await ensureEngine()
        } catch {
          // The engine is a lazy dynamic import. A tab opened before a deploy can
          // no longer fetch its old hashed chunk (gone from the server, and the
          // new service worker purged it from cache), so the import rejects. Left
          // uncaught this rejection is swallowed by the gate's `void start()` and
          // the button silently does nothing — surface a reload prompt. (M3)
          dispatch({ type: 'SET_STATUS', status: 'A new version is available — reload the page to start audio.' })
          return
        }
        try {
          await e.start()
          dispatch({ type: 'SET_AUDIO_READY', ready: true })
          // A publish enabled before start now has its tap.
          applyMbusPublish()
        } catch {
          dispatch({ type: 'SET_STATUS', status: 'Could not start audio. Please try again.' })
        }
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
        // Switching away from (or re-selecting) mbus drops the old subscription.
        closeMbusInput(trackId)
        if (kind === 'mbus') {
          // Turn discovery on so the strip's source picker fills; subscribing
          // happens when the user picks a source (chooseMbusSource).
          ensureMbusClient()
          engineRef.current?.detachInput(trackId)
          return
        }
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
          loadIntoEngine(decoded) // copies channels so the cached source stays intact (H1)
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
          const imported = parseImport(await file.text())
          // Fresh id: an imported export is a copy, so autosave can't overwrite a
          // newer stored session that reused the same id. (H9)
          dispatch({ type: 'LOAD_SESSION', session: { ...imported, id: newId() } })
          dispatch({ type: 'SET_STATUS', status: 'Imported arrangement — link/JSON does not carry the audio blobs.' })
        } catch (err) {
          dispatch({ type: 'SET_STATUS', status: err instanceof Error ? err.message : 'Could not import that file.' })
        }
      },
      async copyShareLink() {
        // encodeSessionLink returns null when the arrangement exceeds the link
        // size limit; don't write an undecodable hash or claim success. (H8)
        const token: string | null = encodeSessionLink(stateRef.current.session)
        if (token === null) {
          dispatch({ type: 'SET_STATUS', status: 'This arrangement is too large to share as a link — export a file instead.' })
          return
        }
        if (typeof location !== 'undefined') location.hash = token
        try {
          const url = typeof location !== 'undefined' ? `${location.origin}${location.pathname}#${token}` : token
          await navigator.clipboard?.writeText(url)
          dispatch({ type: 'SET_STATUS', status: 'Share link copied to the clipboard.' })
        } catch {
          dispatch({ type: 'SET_STATUS', status: 'Share link is in the address bar (clipboard was blocked).' })
        }
      },
      setMbusPublish(on: boolean) {
        mbusWantedRef.current = on
        applyMbusPublish()
      },
      chooseMbusSource(trackId: string, sourceId: string) {
        closeMbusInput(trackId)
        const e = engineRef.current
        if (!e || sourceId === '') return
        // The engine's own context (via its master tap): a live subscription
        // needs a running AudioContext to carry samples into the stream.
        const tap = e.getMasterTap()
        const ctx = tap ? (tap.context as AudioContext) : null
        if (!ctx) {
          dispatch({ type: 'SET_STATUS', status: 'Start audio before picking an mbus source.' })
          return
        }
        try {
          const sub = ensureMbusClient().subscribe(sourceId, ctx)
          const dest = ctx.createMediaStreamDestination()
          sub.node.connect(dest)
          e.attachInput(trackId, dest.stream)
          mbusInputsRef.current.set(trackId, { sub, dest })
          setMbusChoices((prev) => ({ ...prev, [trackId]: sourceId }))
        } catch {
          // One subscription per source per client — a second track wanting the
          // same source is the realistic thrower here.
          dispatch({ type: 'SET_STATUS', status: 'That source is already feeding another track.' })
        }
      },
    }
    // stateRef/posRef/etc are stable refs; dispatch/ensureEngine/gatherSources/persist/loadIntoEngine are memoized.
  }, [dispatch, ensureEngine, gatherSources, persist, stateRef, loadIntoEngine, applyMbusPublish, ensureMbusClient, closeMbusInput])

  return { controls, posRef, meterRef, mbusSources, mbusChoices }
}
