// mtape — a no-op EngineControls for unit tests.
//
// It makes NO sound and touches NO Web Audio: every push method just records
// its arguments so a test can assert the UI drove the engine correctly, and
// `emit()` lets a test simulate worklet events (position, meters, recordComplete,
// ended) flowing back to the hook. The UI is injected this via `useEngine`'s
// `createEngine` option so component/hook tests never touch real audio.

import type { DecodedAudio, EngineControls, EngineEventListener } from '../audio/engineApi'
import type { EngineEvent, TrackArrangement } from '../audio/messages'
import type { LoopRegion, MasterBus } from '../audio/contracts'

export interface MockEngineOptions {
  /** Simulate a browser where tab capture is unavailable (rejects captureTab). */
  failTab?: boolean
  latencySec?: number
}

export interface MockEngine extends EngineControls {
  /** Push an event to every subscriber, exactly as the worklet would. */
  emit(event: EngineEvent): void
  /** Ordered log of imperative calls, for assertions. */
  readonly calls: Array<{ method: string; args: unknown[] }>
  readonly arrangements: TrackArrangement[][]
}

export function createMockEngine(opts: MockEngineOptions = {}): MockEngine {
  const listeners = new Set<EngineEventListener>()
  const calls: Array<{ method: string; args: unknown[] }> = []
  const arrangements: TrackArrangement[][] = []
  let running = false

  const log = (method: string, ...args: unknown[]): void => {
    calls.push({ method, args })
  }

  // jsdom has no MediaStream constructor; a structurally-empty stand-in is
  // enough because the mock never actually routes audio through it.
  const fakeStream = { getAudioTracks: () => [{}] } as unknown as MediaStream

  return {
    calls,
    arrangements,
    async start() {
      running = true
      log('start')
    },
    isRunning: () => running,
    latencySec: () => opts.latencySec ?? 0,
    play: () => log('play'),
    stop: () => log('stop'),
    record: () => log('record'),
    seek: (positionSec: number) => log('seek', positionSec),
    setTempo: (tempo: number) => log('setTempo', tempo),
    setLoop: (loop: LoopRegion) => log('setLoop', loop),
    setMetronome: (enabled: boolean, countInBars: number) => log('setMetronome', enabled, countInBars),
    setMaster: (master: MasterBus) => log('setMaster', master),
    setArrangement: (tracks: TrackArrangement[]) => {
      arrangements.push(tracks)
      log('setArrangement', tracks)
    },
    loadAudio: (audio: DecodedAudio) => log('loadAudio', audio.audioId),
    unloadAudio: (audioId: string) => log('unloadAudio', audioId),
    async captureTab() {
      log('captureTab')
      if (opts.failTab) throw new Error('Tab capture is Chromium-desktop only')
      return fakeStream
    },
    async captureMic() {
      log('captureMic')
      return fakeStream
    },
    attachInput: (trackId: string) => log('attachInput', trackId),
    detachInput: (trackId: string) => log('detachInput', trackId),
    onEvent(listener: EngineEventListener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit(event: EngineEvent) {
      for (const l of listeners) l(event)
    },
    dispose() {
      running = false
      listeners.clear()
      log('dispose')
    },
  }
}
