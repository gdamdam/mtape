// mtape — the imperative control surface between React and the audio world.
//
// The UI never touches the AudioContext, the worklet, or getUserMedia directly.
// It holds one object implementing `EngineControls`, pushes declarative state to
// it, and subscribes to `EngineEvent`s coming back. A mock implementation of this
// interface lets the UI be unit-tested with no real audio.

import type { LoopRegion, MasterBus } from './contracts'
import type { EngineEvent, TrackArrangement } from './messages'

/** A decoded audio asset ready to hand to the engine / renderer. */
export interface DecodedAudio {
  audioId: string
  channels: Float32Array[]
  sampleRate: number
  durationSec: number
}

/** Options for an offline mixdown. */
export interface RenderOptions {
  sampleRate: number
  startSec: number
  endSec: number
  /** Per-track solo/mute is read from the arrangement; this just bounds output. */
  channels?: 1 | 2
}

export type EngineEventListener = (event: EngineEvent) => void

/**
 * The full control surface. `start()` must be called from a user gesture before
 * anything else produces sound (browser autoplay policy). Every push method is a
 * no-op until the context is running.
 */
export interface EngineControls {
  /** Create + resume the AudioContext and load the worklet. Idempotent. */
  start(): Promise<void>
  isRunning(): boolean
  /** Round-trip capture latency in seconds, used to align recorded takes. */
  latencySec(): number

  // Transport
  play(): void
  stop(): void
  record(): void
  seek(positionSec: number): void

  // Declarative state push
  setTempo(tempo: number): void
  setLoop(loop: LoopRegion): void
  setMetronome(enabled: boolean, countInBars: number): void
  setMaster(master: MasterBus): void
  setArrangement(tracks: TrackArrangement[]): void

  // Audio asset lifecycle (samples live in the worklet + IndexedDB)
  loadAudio(audio: DecodedAudio): void
  unloadAudio(audioId: string): void

  // Capture sources. Resolve once a track is armed and receiving from the source.
  captureTab(): Promise<MediaStream>
  captureMic(): Promise<MediaStream>
  attachInput(trackId: string, stream: MediaStream): void
  detachInput(trackId: string): void

  // Events
  onEvent(listener: EngineEventListener): () => void

  /** End-of-chain output node (the worklet mix) for publishing to the mbus
   *  patchbay. null until running. */
  getMasterTap(): AudioNode | null

  dispose(): void
}
