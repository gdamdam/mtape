/**
 * AudioEngine — the main-thread adapter implementing `EngineControls`.
 *
 * Graph:
 *   input source ─▶ mtape worklet (input 0)                (dry capture bus)
 *   input source ─▶ monitorGain(0) ─▶ destination          (per-track monitor, OFF)
 *   mtape worklet ─▶ destination                           (the mix)
 *
 * The UI pushes declarative state; the worklet does all DSP. Capture sources
 * (tab/mic) feed the worklet's single input for recording. Input monitoring is
 * OFF by default (feedback safety) — there is no toggle on this interface, so the
 * monitor gain node exists at 0 purely so the plumbing is disconnectable.
 *
 * RECORD ENRICHMENT: the worklet emits `recordChunk`/`recordComplete` with an
 * empty `audioId` and RAW timing. This engine mints one `audioId` per take
 * (`crypto.randomUUID()` at record start) and, on `recordComplete`, converts the
 * raw start with `compensateRecordStart(startSec, latencySec)` before fanning the
 * enriched event out to listeners.
 */
import { compensateRecordStart } from '../transport/timing'
import type { LoopRegion, MasterBus } from './contracts'
import type { DecodedAudio, EngineControls, EngineEventListener } from './engineApi'
import type { EngineCommand, EngineEvent, TrackArrangement } from './messages'
import mtapeWorkletUrl from './worklets/mtape.worklet.ts?worker&url'

/** Per-attached-input nodes, kept so `detachInput`/`dispose` can tear them down. */
interface InputHandle {
  source: MediaStreamAudioSourceNode
  monitor: GainNode
  stream: MediaStream
}

export class AudioEngine implements EngineControls {
  private ctx: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private inputs = new Map<string, InputHandle>()
  private listeners = new Set<EngineEventListener>()

  private starting: Promise<void> | null = null
  private disposed = false
  private latencySecValue = 0

  // FIFO of take ids minted at each record start but not yet completed. The
  // worklet posts record events with an empty id and RAW timing; we assign ids
  // in completion order so a stop→record burst can't glue take 1's tail into
  // take 2 (the id is bound to the take, not to whenever the event is handled). (M1)
  private recAudioIds: string[] = []
  // Mirrors the worklet's record state so a second record() while recording is
  // ignored rather than minting a stray id / clobbering the active take. (H5)
  private recording = false

  private readonly onVisibility = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') void this.tryResume()
  }

  isRunning(): boolean {
    return this.ctx?.state === 'running' && this.node !== null
  }

  latencySec(): number {
    return this.latencySecValue
  }

  getMasterTap(): AudioNode | null {
    return this.node
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error('AudioEngine disposed')
    if (this.isRunning()) return
    if (this.starting) return this.starting
    this.starting = this.boot()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  private async boot(): Promise<void> {
    const ctx =
      this.ctx ??
      new (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
    this.ctx = ctx
    if (ctx.state === 'suspended') await ctx.resume()
    // dispose() may have run during the await above; don't build a graph on a
    // context that is being torn down (StrictMode mount/unmount, tab close). (L4)
    if (this.disposed) return

    if (!this.node) {
      await ctx.audioWorklet.addModule(mtapeWorkletUrl)
      if (this.disposed) return
      const node = new AudioWorkletNode(ctx, 'mtape-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      })
      node.port.onmessage = (e: MessageEvent<EngineEvent>) => this.handleEvent(e.data)
      node.connect(ctx.destination)
      this.node = node

      // Round-trip latency drives take alignment; the worklet reports raw timing.
      this.latencySecValue = (ctx.baseLatency || 0) + (ctx.outputLatency || 0)
      this.post({ type: 'setLatency', latencySec: this.latencySecValue })
    }

    if (this.disposed) return
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility)
      window.addEventListener('pageshow', this.onVisibility)
    }
  }

  private async tryResume(): Promise<void> {
    try {
      if (this.ctx && this.ctx.state !== 'running' && !this.disposed) await this.ctx.resume()
    } catch {
      /* best-effort auto-resume */
    }
  }

  private post(cmd: EngineCommand, transfer?: Transferable[]): void {
    if (!this.node) return // no-op until started
    if (transfer && transfer.length > 0) this.node.port.postMessage(cmd, transfer)
    else this.node.port.postMessage(cmd)
  }

  // ------------------------------------------------------------------ transport

  play(): void {
    this.post({ type: 'transport', action: 'play' })
  }

  stop(): void {
    // Clear the flag now so an immediate record() is honoured; the take id stays
    // queued until the worklet's recordComplete arrives (see handleEvent). (M1)
    this.recording = false
    this.post({ type: 'transport', action: 'stop' })
  }

  record(): void {
    if (!this.node || !this.ctx) return
    if (this.recording) return // already recording — ignore double-record (H5)
    this.recording = true
    // Refresh latency per take: outputLatency is typically 0 until playback has
    // begun and can change on a device switch, so a value snapshotted at context
    // creation is stale. (M4)
    this.latencySecValue = (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0)
    this.post({ type: 'setLatency', latencySec: this.latencySecValue })
    // Mint the take's asset id up front; the worklet's raw events inherit it in
    // completion order via the FIFO queue.
    this.recAudioIds.push(crypto.randomUUID())
    this.post({ type: 'transport', action: 'record' })
  }

  seek(positionSec: number): void {
    this.post({ type: 'seek', positionSec })
  }

  // ------------------------------------------------------------------ state push

  setTempo(tempo: number): void {
    this.post({ type: 'setTempo', tempo })
  }

  setLoop(loop: LoopRegion): void {
    this.post({ type: 'setLoop', loop })
  }

  setMetronome(enabled: boolean, countInBars: number): void {
    this.post({ type: 'setMetronome', enabled, countInBars })
  }

  setMaster(master: MasterBus): void {
    this.post({ type: 'setMaster', master })
  }

  setArrangement(tracks: TrackArrangement[]): void {
    this.post({ type: 'setArrangement', tracks })
  }

  // ------------------------------------------------------------------ assets

  loadAudio(audio: DecodedAudio): void {
    // Samples are transferred (zero-copy) — the caller's Float32Arrays detach.
    const channels = audio.channels
    const transfer = channels.map((c) => c.buffer as ArrayBuffer)
    this.post({ type: 'loadAudio', audioId: audio.audioId, channels, sampleRate: audio.sampleRate }, transfer)
  }

  unloadAudio(audioId: string): void {
    this.post({ type: 'unloadAudio', audioId })
  }

  // ------------------------------------------------------------------ capture

  async captureTab(): Promise<MediaStream> {
    // Chromium-desktop only: tab audio requires getDisplayMedia with audio:true.
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    const audioTracks = stream.getAudioTracks()
    if (audioTracks.length === 0) {
      // No shared audio (wrong surface, or a browser without tab audio) — clean up.
      for (const t of stream.getTracks()) t.stop()
      throw new Error('No audio track in the shared surface. Share a Chrome tab with "Share tab audio" enabled.')
    }
    // Drop the video tracks; only audio feeds the recorder.
    for (const v of stream.getVideoTracks()) {
      v.stop()
      stream.removeTrack(v)
    }
    return stream
  }

  async captureMic(): Promise<MediaStream> {
    // Processing disabled so we capture the true signal, not a voice-tuned one.
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    })
  }

  attachInput(trackId: string, stream: MediaStream): void {
    const ctx = this.ctx
    if (!ctx || !this.node) return
    this.detachInput(trackId) // idempotent: replace any prior attachment
    const source = ctx.createMediaStreamSource(stream)
    source.connect(this.node) // feed the worklet's record bus (input 0)
    // Monitor path exists but stays silent (feedback safety; no toggle here).
    const monitor = ctx.createGain()
    monitor.gain.value = 0
    source.connect(monitor).connect(ctx.destination)
    this.inputs.set(trackId, { source, monitor, stream })
  }

  detachInput(trackId: string): void {
    const handle = this.inputs.get(trackId)
    if (!handle) return
    handle.source.disconnect()
    handle.monitor.disconnect()
    for (const t of handle.stream.getTracks()) t.stop()
    this.inputs.delete(trackId)
  }

  // ------------------------------------------------------------------ events

  onEvent(listener: EngineEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private handleEvent(event: EngineEvent): void {
    // Enrich the worklet's raw record events with the minted id (and, for the
    // completion, latency-compensated start) before fanning out.
    let out = event
    if (event.type === 'recordChunk') {
      // Head of the queue is the in-progress take; don't dequeue until completion.
      out = { ...event, audioId: this.recAudioIds[0] ?? '' }
    } else if (event.type === 'recordComplete') {
      // Bind to (and retire) the oldest outstanding take id, so late-arriving
      // completion events after a stop→record burst still tag the right take. (M1)
      const audioId = this.recAudioIds.shift() ?? ''
      out = {
        ...event,
        audioId,
        startSec: compensateRecordStart(event.startSec, this.latencySecValue),
      }
    } else if (event.type === 'ended') {
      this.recording = false
    }
    for (const l of this.listeners) l(out)
  }

  dispose(): void {
    this.disposed = true
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility)
      window.removeEventListener('pageshow', this.onVisibility)
    }
    for (const trackId of [...this.inputs.keys()]) this.detachInput(trackId)
    this.node?.disconnect()
    this.node = null
    if (this.ctx && this.ctx.state !== 'closed') void this.ctx.close()
    this.ctx = null
    this.listeners.clear()
  }
}

/** Factory the UI wires to; returns the interface, never the concrete class. */
export function createEngine(): EngineControls {
  return new AudioEngine()
}
