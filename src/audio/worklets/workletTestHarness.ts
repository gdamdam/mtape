// Test-only harness that lets MtapeProcessor run under vitest's node environment.
//
// The worklet depends on three globals the browser's AudioWorklet scope provides
// but node does not: the `AudioWorkletProcessor` base class, a `sampleRate`
// number, and `registerProcessor`. We install minimal stand-ins BEFORE importing
// the worklet module — its `extends AudioWorkletProcessor` clause and its
// bottom-of-file `registerProcessor(...)` both run at import time — capture the
// registered class, and drive it by calling process() with fabricated buffers
// while reading the messages it posts back through its (fake) port.

import type { EngineCommand, EngineEvent } from '../messages'

export interface PostedMessage {
  data: EngineEvent
}

interface FakePort {
  posted: PostedMessage[]
  onmessage: ((e: { data: unknown }) => void) | null
  postMessage(data: unknown, transfer?: unknown): void
}

class FakeAudioWorkletProcessor {
  port: FakePort
  constructor() {
    const posted: PostedMessage[] = []
    this.port = {
      posted,
      onmessage: null,
      // Ignore the transfer list on purpose: the real postMessage DETACHES the
      // transferred ArrayBuffers, but the test needs to read the posted PCM back.
      postMessage(data: unknown) {
        posted.push({ data: data as EngineEvent })
      },
    }
  }
}

interface WorkletInstance {
  port: FakePort
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean
}

let capturedClass: (new () => WorkletInstance) | null = null

// Install globals at module load, before the worklet is ever imported.
const g = globalThis as unknown as {
  AudioWorkletProcessor: unknown
  registerProcessor: unknown
  sampleRate: number
}
g.AudioWorkletProcessor = FakeAudioWorkletProcessor
g.registerProcessor = (_name: string, cls: new () => WorkletInstance): void => {
  capturedClass = cls
}
g.sampleRate = 48000

export interface Harness {
  /** The live processor instance (typed loosely so tests can spy on privates). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proc: WorkletInstance & Record<string, any>
  /** Every message the worklet has posted, in order. */
  posted: PostedMessage[]
  /** Simulate a main-thread command reaching the worklet's port. */
  send(cmd: EngineCommand): void
  /** Run one render quantum. `input` is channel-major (null/[] = no input). */
  process(input: Float32Array[] | null, len: number): { outL: Float32Array; outR: Float32Array }
  /** Posted events of a given type, in order. */
  events<T extends EngineEvent['type']>(type: T): Array<Extract<EngineEvent, { type: T }>>
}

/**
 * Build a harness at a given sample rate. The worklet reads `sampleRate` as a
 * live global, so create + fully drive one harness before creating another at a
 * different rate — the global is shared.
 */
export async function createHarness(opts: { sampleRate?: number } = {}): Promise<Harness> {
  g.sampleRate = opts.sampleRate ?? 48000
  await import('./mtape.worklet') // cached after first import; registers the class
  if (!capturedClass) throw new Error('worklet did not register a processor')
  g.sampleRate = opts.sampleRate ?? 48000 // ensure the ctor reads the requested rate
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proc = new capturedClass() as WorkletInstance & Record<string, any>
  const posted = proc.port.posted
  return {
    proc,
    posted,
    send(cmd) {
      proc.port.onmessage?.({ data: cmd })
    },
    process(input, len) {
      const outL = new Float32Array(len)
      const outR = new Float32Array(len)
      proc.process([input ?? []], [[outL, outR]])
      return { outL, outR }
    },
    events(type) {
      return posted
        .map((m) => m.data)
        .filter((d): d is Extract<EngineEvent, { type: typeof type }> => d.type === type)
    },
  }
}
