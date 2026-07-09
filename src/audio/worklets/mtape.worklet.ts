/**
 * MtapeProcessor — the real-time audio engine.
 *
 * This is a thin AudioWorkletProcessor: it owns NO DSP maths of its own beyond
 * glue (metronome click synthesis + a linear meter accumulator). Every audible
 * chain — per-clip source read, per-track EQ / tape / gain / pan, and the master
 * gain / drive / limiter — reuses the same pure modules the offline reference
 * (`renderSession`) composes, so LIVE playback matches the OFFLINE mixdown.
 *
 * TRUST BOUNDARY: every inbound port message is run through `sanitizeCommand`
 * before it can touch DSP state; malformed messages are dropped.
 *
 * RECORD-COMPLETE CONTRACT: the worklet cannot mint ids or know the round-trip
 * latency, so it reports RAW frames. It posts `recordChunk`/`recordComplete`
 * with an empty `audioId` and the raw (uncompensated) start time; the main-thread
 * AudioEngine mints the `audioId` and applies `compensateRecordStart`.
 *
 * Deliberate deviations from `renderSession` (documented for the integrator):
 *  - Wow/flutter is NOT applied live. The offline read is acausal (it reads
 *    future samples via a full-buffer modulated delay); a streaming worklet has
 *    no future. Per the engine spec's per-frame chain, only `softSaturate` runs.
 *  - Master varispeed is NOT applied live. The offline path resamples the whole
 *    finished mix; that cannot be done sample-accurately in a push-model worklet.
 *  Both features remain exact in the offline render used for export.
 */
import type { ClipPlacement, EngineCommand, EngineEvent, TrackArrangement, TrackMeter } from '../messages'
import { sanitizeCommand } from '../messages'
import { sanitizeMaster, TEMPO_DEFAULT, type Clip, type LoopRegion, type MasterBus, type TimeSignature } from '../contracts'
import { dbToLin, panGains, trackGainLin } from '../dsp/gain'
import { BrickwallLimiter, softClipDrive } from '../dsp/dynamics'
import { interpolateSample, softSaturate } from '../dsp/tape'
import { ThreeBandEqProcessor } from '../dsp/eq'
import { clipEndSec, fadeGainAt } from '../../clips/clipMath'
import { secondsPerBeat } from '../../transport/timing'

/** A decoded source asset held in the worklet, keyed by audioId. */
interface LiveSource {
  channels: Float32Array[]
  sampleRate: number
}

/**
 * Per-track live state. `clips` are reconstructed `Clip`s so we can reuse the
 * shared `clipEndSec`/`fadeGainAt` geometry unchanged. The EQ processor is kept
 * persistent (its delay memory must survive across quanta and param tweaks).
 */
interface LiveTrack {
  arr: TrackArrangement
  clips: Clip[]
  eq: ThreeBandEqProcessor
  // Meter accumulators (reset each telemetry post).
  meterPeak: number
  meterSumSq: number
  meterCount: number
}

/** Metronome assumes 4/4 — no time signature crosses the command boundary. */
const METRO_TS: TimeSignature = { numerator: 4, denominator: 4 }
/** Click envelope length and level (glue synthesis, not part of the mix chain). */
const CLICK_SEC = 0.03
const CLICK_GAIN = 0.25
const CLICK_BAR_HZ = 1500
const CLICK_BEAT_HZ = 1000
/** Telemetry cadence: ~1024 frames keeps the port quiet vs. per-quantum posts. */
const POST_INTERVAL_FRAMES = 1024

/** Read a source as mono at a fractional SOURCE-sample index (renderSession law:
 *  multichannel is averaged so every downstream track chain is mono). */
function readSourceMono(src: LiveSource, index: number): number {
  const chs = src.channels
  const n = chs.length
  if (n === 0) return 0
  // Past either end of the recorded material there is nothing to play.
  // interpolateSample would clamp to the edge sample (an audible DC hold), so a
  // clip trimmed past its source must read as silence — matching the offline
  // render, which shares this law. (L6)
  if (index < 0 || index >= chs[0].length) return 0
  if (n === 1) return interpolateSample(chs[0], index)
  let sum = 0
  for (let c = 0; c < n; c++) sum += interpolateSample(chs[c], index)
  return sum / n
}

/** Reconstruct a full `Clip` from the leaner arrangement placement. */
function placementToClip(p: ClipPlacement): Clip {
  return {
    id: p.clipId,
    audioId: p.audioId,
    startSec: p.startSec,
    offsetSec: p.offsetSec,
    durationSec: p.durationSec,
    gainDb: p.gainDb,
    fades: { inSec: p.fadeInSec, outSec: p.fadeOutSec },
  }
}

class MtapeProcessor extends AudioWorkletProcessor {
  private samples = new Map<string, LiveSource>()
  private liveTracks: LiveTrack[] = []
  // Audible subset cached from liveTracks (solo/mute law). Recomputed only when
  // the arrangement is rebuilt — solo/mute never mutate in place — so the audio
  // render path reads it without allocating a fresh array every quantum.
  private audibleTracks: LiveTrack[] = []

  // Transport.
  private playing = false
  private recording = false
  private posFrame = 0

  // Declarative state.
  private tempo = TEMPO_DEFAULT
  private loop: LoopRegion = { enabled: false, startSec: 0, endSec: 0 }
  private metronome = { enabled: false, countInBars: 0 }
  private master: MasterBus = sanitizeMaster({})

  // Master limiters (per channel), persistent so release state survives.
  private limL: BrickwallLimiter
  private limR: BrickwallLimiter

  // Scratch stereo bus (reused per quantum).
  private busL = new Float32Array(128)
  private busR = new Float32Array(128)
  private dry = new Float32Array(128)

  // Metronome click state.
  private lastBeat = -1
  private clickRemaining = 0
  private clickFrame = 0
  private clickIsBar = false
  private countInRemaining = 0
  private countInFrame = 0

  // Recording capture.
  private recTrackId = ''
  private recStarted = false
  private recChannelCount = 1
  private recStartFrame = 0
  private recTotalFrames = 0
  private recChunk: Float32Array[] = []
  private recChunkFill = 0
  private recChunkStartFrame = 0

  // Telemetry accumulators.
  private blockFrames = 0
  private mPeakL = 0
  private mPeakR = 0
  private mSumSq = 0
  private mFrames = 0

  constructor() {
    super()
    this.limL = new BrickwallLimiter({ ceilingDb: this.master.limiterCeilingDb, sampleRate })
    this.limR = new BrickwallLimiter({ ceilingDb: this.master.limiterCeilingDb, sampleRate })
    this.port.onmessage = (e: MessageEvent<unknown>) => {
      const cmd = sanitizeCommand(e.data)
      if (cmd) this.handle(cmd)
    }
  }

  // ------------------------------------------------------------------ commands

  private handle(cmd: EngineCommand): void {
    switch (cmd.type) {
      case 'transport':
        this.onTransport(cmd.action)
        break
      case 'seek': {
        // Ignore seeks mid-take: capture stays linear from recStartFrame, so
        // moving the playhead would desync the take from the timeline. (M2)
        if (this.recording) break
        this.posFrame = Math.round(cmd.positionSec * sampleRate)
        // Latch lastBeat to the beat the new position sits in, so the very next
        // quantum's beatIndex matches and no off-grid click fires. Setting it to
        // -1 would GUARANTEE the spurious click it was meant to avoid. (M15)
        const framesPerBeat = secondsPerBeat(this.tempo, METRO_TS) * sampleRate
        this.lastBeat = framesPerBeat > 0 ? Math.floor(this.posFrame / framesPerBeat) : -1
        break
      }
      case 'setTempo':
        this.tempo = cmd.tempo
        break
      case 'setLoop':
        this.loop = cmd.loop
        break
      case 'setMetronome':
        this.metronome = { enabled: cmd.enabled, countInBars: cmd.countInBars }
        break
      case 'setMaster':
        this.master = cmd.master
        this.limL.setCeiling(cmd.master.limiterCeilingDb)
        this.limR.setCeiling(cmd.master.limiterCeilingDb)
        break
      case 'setArrangement':
        this.rebuildArrangement(cmd.tracks)
        break
      case 'loadAudio':
        this.samples.set(cmd.audioId, { channels: cmd.channels, sampleRate: cmd.sampleRate })
        break
      case 'unloadAudio':
        this.samples.delete(cmd.audioId)
        break
      case 'setLatency':
        // No-op in the worklet: take alignment is done on the main thread, which
        // owns the latency figure and applies `compensateRecordStart`. Handled
        // (not dropped) so the command stays a recognised part of the protocol.
        break
      default:
        break
    }
  }

  private onTransport(action: 'play' | 'stop' | 'record'): void {
    switch (action) {
      case 'play':
        this.playing = true
        break
      case 'stop':
        if (this.recording) this.finalizeRecording()
        this.recording = false
        this.playing = false
        this.countInRemaining = 0
        this.port.postMessage({ type: 'ended' } satisfies EngineEvent)
        break
      case 'record': {
        // A second record while a take is in progress is ignored so the active
        // take keeps running rather than being silently reset and discarded. (H5)
        if (this.recording) break
        // Latch the single armed track now; arrangement edits mid-take won't move it.
        this.recTrackId = this.liveTracks.find((lt) => lt.arr.armed)?.arr.trackId ?? ''
        this.recording = true
        this.playing = true
        this.recStarted = false
        // Metronome count-in freezes the playhead for N bars of clicks first.
        const barFrames = secondsPerBeat(this.tempo, METRO_TS) * METRO_TS.numerator * sampleRate
        this.countInRemaining =
          this.metronome.enabled && this.metronome.countInBars > 0
            ? Math.round(this.metronome.countInBars * barFrames)
            : 0
        this.countInFrame = 0
        this.lastBeat = -1
        break
      }
      default:
        break
    }
  }

  /** Rebuild per-track state, preserving EQ delay memory by trackId (click-free). */
  private rebuildArrangement(tracks: TrackArrangement[]): void {
    const prev = new Map<string, LiveTrack>()
    for (const lt of this.liveTracks) prev.set(lt.arr.trackId, lt)
    this.liveTracks = tracks.map((arr) => {
      const existing = prev.get(arr.trackId)
      const eq = existing?.eq ?? new ThreeBandEqProcessor(arr.eq, sampleRate)
      eq.setParams(arr.eq) // recompute coefficients in place; state intact
      return {
        arr,
        clips: arr.clips.map(placementToClip),
        eq,
        meterPeak: 0,
        meterSumSq: 0,
        meterCount: 0,
      }
    })
    this.audibleTracks = this.computeAudible()
  }

  // ------------------------------------------------------------------ audio

  /**
   * Resolve audible tracks (renderSession law): if ANY track is soloed, only
   * soloed & non-muted tracks play; otherwise every non-muted track plays.
   */
  private computeAudible(): LiveTrack[] {
    const anySolo = this.liveTracks.some((lt) => lt.arr.solo)
    if (anySolo) return this.liveTracks.filter((lt) => lt.arr.solo && !lt.arr.mute)
    return this.liveTracks.filter((lt) => !lt.arr.mute)
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const outL = output[0]
    const outR = output.length > 1 ? output[1] : output[0]
    const len = outL.length

    if (this.busL.length !== len) {
      this.busL = new Float32Array(len)
      this.busR = new Float32Array(len)
      this.dry = new Float32Array(len)
    }
    const busL = this.busL
    const busR = this.busR
    busL.fill(0)
    busR.fill(0)

    const input = inputs[0]
    const inCountIn = this.recording && this.countInRemaining > 0

    if (inCountIn) {
      // Count-in: clicks only, playhead frozen, no capture.
      if (this.metronome.enabled) this.mixMetronome(this.countInFrame, busL, busR, len)
      this.countInFrame += len
      this.countInRemaining -= len
      if (this.countInRemaining <= 0) {
        this.countInRemaining = 0
        this.lastBeat = -1 // hand off cleanly to the play-phase click grid
      }
    } else {
      if (this.playing) this.renderTracks(busL, busR, len)
      if (this.metronome.enabled && (this.playing || this.recording)) {
        this.mixMetronome(this.posFrame, busL, busR, len)
      }
    }

    // Master chain — runs every quantum so the limiter release stays continuous.
    this.renderMaster(busL, busR, outL, outR, len)

    if (this.recording && !inCountIn) this.captureInput(input, len)
    if (this.playing && !inCountIn) this.advance(len)

    this.blockFrames += len
    if (this.blockFrames >= POST_INTERVAL_FRAMES) {
      this.postTelemetry()
      this.blockFrames = 0
    }
    return true
  }

  /** Sum audible tracks into the stereo bus, mirroring renderSession's per-track
   *  chain: dry clip render → EQ → optional saturation → gain/pan. */
  private renderTracks(busL: Float32Array, busR: Float32Array, len: number): void {
    const posSec = this.posFrame / sampleRate
    const dry = this.dry
    for (const lt of this.audibleTracks) {
      const arr = lt.arr
      dry.fill(0)

      for (const clip of lt.clips) {
        const src = this.samples.get(clip.audioId)
        if (!src) continue // missing backing audio => silent, never throws
        const clipStart = clip.startSec
        const clipEnd = clipEndSec(clip)
        // Half-open [clipStart, clipEnd): first/last frames overlapping this quantum.
        const first = Math.max(0, Math.ceil((clipStart - posSec) * sampleRate))
        const lastExcl = Math.min(len, Math.ceil((clipEnd - posSec) * sampleRate))
        if (lastExcl <= first) continue
        const clipLin = dbToLin(clip.gainDb)
        for (let f = first; f < lastExcl; f++) {
          const arrTime = posSec + f / sampleRate
          const clipLocal = arrTime - clipStart
          const sourceTime = clip.offsetSec + clipLocal
          const g = clipLin * fadeGainAt(clip, clipLocal)
          if (g !== 0) dry[f] += readSourceMono(src, sourceTime * src.sampleRate) * g
        }
      }

      const tapeOn = arr.tape.enabled && arr.tape.saturation > 0
      const sat = arr.tape.saturation
      const g = trackGainLin(arr.gainDb)
      const pan = panGains(arr.pan)
      const gl = g * pan.left
      const gr = g * pan.right
      let peak = lt.meterPeak
      let sumSq = lt.meterSumSq
      for (let f = 0; f < len; f++) {
        // EQ runs on every frame (incl. silence) so its state matches the reference.
        let s = lt.eq.process(dry[f])
        if (tapeOn) s = softSaturate(s, sat)
        const a = s < 0 ? -s : s
        if (a > peak) peak = a
        sumSq += s * s
        busL[f] += s * gl
        busR[f] += s * gr
      }
      lt.meterPeak = peak
      lt.meterSumSq = sumSq
      lt.meterCount += len
    }
  }

  /** Master gain → soft-clip drive → per-channel brick-wall limiter → output. */
  private renderMaster(
    busL: Float32Array,
    busR: Float32Array,
    outL: Float32Array,
    outR: Float32Array,
    len: number,
  ): void {
    const masterLin = dbToLin(this.master.gainDb)
    const drive = this.master.drive
    let peakL = this.mPeakL
    let peakR = this.mPeakR
    let sumSq = this.mSumSq
    for (let f = 0; f < len; f++) {
      let l = busL[f] * masterLin
      let r = busR[f] * masterLin
      if (drive !== 0) {
        l = softClipDrive(l, drive)
        r = softClipDrive(r, drive)
      }
      l = this.limL.process(l)
      r = this.limR.process(r)
      if (outR !== outL) {
        outL[f] = l
        outR[f] = r
      } else {
        // Single-channel output: average both legs so a mono device matches the
        // offline (L+R)/2 downmix instead of dropping the right leg. (L3)
        outL[f] = 0.5 * (l + r)
      }
      const al = l < 0 ? -l : l
      const ar = r < 0 ? -r : r
      if (al > peakL) peakL = al
      if (ar > peakR) peakR = ar
      sumSq += l * l + r * r
    }
    this.mPeakL = peakL
    this.mPeakR = peakR
    this.mSumSq = sumSq
    this.mFrames += len
  }

  private advance(len: number): void {
    this.posFrame += len
    // Loop-wrapping mid-take would place post-wrap audio at a timeline position
    // that doesn't match what the performer heard, so honour the loop only when
    // not recording. (M2)
    if (!this.recording && this.loop.enabled && this.loop.endSec > this.loop.startSec) {
      const endFrame = this.loop.endSec * sampleRate
      if (this.posFrame >= endFrame) {
        const startFrame = this.loop.startSec * sampleRate
        // Preserve the overshoot so looped playback doesn't drift or judder.
        this.posFrame = startFrame + (this.posFrame - endFrame)
        // Re-latch the click grid to the wrapped position, otherwise the stale
        // (pre-wrap, higher) beat index makes the next quantum read as a new beat
        // and fire a spurious metronome click at every loop seam. Mirrors the
        // seek handler's latch. (M4)
        const framesPerBeat = secondsPerBeat(this.tempo, METRO_TS) * sampleRate
        this.lastBeat = framesPerBeat > 0 ? Math.floor(this.posFrame / framesPerBeat) : -1
      }
    }
  }

  /** Enveloped sine click at each beat boundary; downbeats ring higher. `base`
   *  is the frame index this quantum starts at (playhead, or count-in counter). */
  private mixMetronome(base: number, busL: Float32Array, busR: Float32Array, len: number): void {
    const framesPerBeat = secondsPerBeat(this.tempo, METRO_TS) * sampleRate
    if (framesPerBeat <= 0) return
    const clickLen = Math.max(1, Math.round(CLICK_SEC * sampleRate))
    for (let f = 0; f < len; f++) {
      const beatIndex = Math.floor((base + f) / framesPerBeat)
      if (beatIndex !== this.lastBeat) {
        this.lastBeat = beatIndex
        this.clickRemaining = clickLen
        this.clickFrame = 0
        this.clickIsBar = beatIndex % METRO_TS.numerator === 0
      }
      if (this.clickRemaining > 0) {
        const env = this.clickRemaining / clickLen // linear decay
        const freq = this.clickIsBar ? CLICK_BAR_HZ : CLICK_BEAT_HZ
        const s = Math.sin((2 * Math.PI * freq * this.clickFrame) / sampleRate) * env * CLICK_GAIN
        busL[f] += s
        if (busR !== busL) busR[f] += s
        this.clickFrame++
        this.clickRemaining--
      }
    }
  }

  // ------------------------------------------------------------------ recording

  private captureInput(input: Float32Array[] | undefined, len: number): void {
    if (this.recTrackId === '') return // nothing armed => nothing to capture
    if (!this.recStarted) {
      // Defer the channel-count latch (and the take's start frame) until the
      // input graph actually delivers a quantum: latching on an empty first
      // quantum would force an entire stereo take to mono. (L5)
      if (!input || input.length === 0) return
      this.recChannelCount = input.length
      this.recStartFrame = Math.round(this.posFrame)
      this.recTotalFrames = 0
      this.allocChunk(this.recStartFrame)
      this.recStarted = true
    }
    const chCount = this.recChannelCount
    const capacity = this.recChunk[0].length
    for (let f = 0; f < len; f++) {
      if (this.recChunkFill >= capacity) this.flushChunk(false)
      for (let c = 0; c < chCount; c++) {
        const inCh = input && c < input.length ? input[c] : undefined
        this.recChunk[c][this.recChunkFill] = inCh ? inCh[f] : 0
      }
      this.recChunkFill++
    }
    this.recTotalFrames += len
  }

  private allocChunk(startFrame: number): void {
    const capacity = Math.max(1, Math.round(sampleRate)) // ~1 s per chunk
    this.recChunk = Array.from({ length: this.recChannelCount }, () => new Float32Array(capacity))
    this.recChunkFill = 0
    this.recChunkStartFrame = startFrame
  }

  /** Post the filled portion of the current chunk (buffers transferred), then
   *  start a fresh chunk unless this is the final flush. */
  private flushChunk(final: boolean): void {
    if (this.recChunkFill > 0) {
      const channels = this.recChunk.map((ch) => ch.slice(0, this.recChunkFill))
      const transfer = channels.map((ch) => ch.buffer as ArrayBuffer)
      this.port.postMessage(
        {
          type: 'recordChunk',
          trackId: this.recTrackId,
          audioId: '', // minted on the main thread
          channels,
          startFrame: this.recChunkStartFrame,
        } satisfies EngineEvent,
        transfer,
      )
    }
    if (!final) this.allocChunk(this.recChunkStartFrame + this.recChunkFill)
  }

  private finalizeRecording(): void {
    if (this.recTrackId !== '' && this.recStarted) {
      this.flushChunk(true)
      // RAW start (uncompensated). The engine subtracts latency + mints the id.
      this.port.postMessage({
        type: 'recordComplete',
        trackId: this.recTrackId,
        audioId: '',
        startSec: this.recStartFrame / sampleRate,
        durationSec: this.recTotalFrames / sampleRate,
      } satisfies EngineEvent)
    }
    this.recStarted = false
  }

  // ------------------------------------------------------------------ telemetry

  private postTelemetry(): void {
    this.port.postMessage({
      type: 'position',
      positionSec: this.posFrame / sampleRate,
      playing: this.playing,
      recording: this.recording,
    } satisfies EngineEvent)

    const tracks: TrackMeter[] = this.liveTracks.map((lt) => {
      const rms = lt.meterCount > 0 ? Math.sqrt(lt.meterSumSq / lt.meterCount) : 0
      const meter: TrackMeter = { trackId: lt.arr.trackId, peak: lt.meterPeak, rms }
      lt.meterPeak = 0
      lt.meterSumSq = 0
      lt.meterCount = 0
      return meter
    })

    const masterRms = this.mFrames > 0 ? Math.sqrt(this.mSumSq / (this.mFrames * 2)) : 0
    this.port.postMessage({
      type: 'meters',
      masterPeakL: this.mPeakL,
      masterPeakR: this.mPeakR,
      masterRms,
      clip: this.mPeakL >= 0.999 || this.mPeakR >= 0.999,
      tracks,
    } satisfies EngineEvent)

    this.mPeakL = 0
    this.mPeakR = 0
    this.mSumSq = 0
    this.mFrames = 0
  }
}

registerProcessor('mtape-processor', MtapeProcessor)
