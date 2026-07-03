/**
 * Ambient declarations for the AudioWorkletGlobalScope. TypeScript's DOM lib does
 * not include the worklet-side globals (`AudioWorkletProcessor`,
 * `registerProcessor`, `sampleRate`, `currentTime`, `currentFrame`). Declaring
 * them locally avoids pulling in an external @types dependency and mirrors the
 * suite (mspectr) pattern.
 */

declare const sampleRate: number
declare const currentTime: number
declare const currentFrame: number

interface AudioWorkletProcessorImpl {
  readonly port: MessagePort
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean
}

declare const AudioWorkletProcessor: {
  prototype: AudioWorkletProcessorImpl
  new (options?: AudioWorkletNodeOptions): AudioWorkletProcessorImpl
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessorImpl,
): void
