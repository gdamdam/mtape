// mtape — pure PCM WAV encoder.
//
// Turns in-memory Float32 channel buffers into a canonical little-endian
// RIFF/WAVE file. PURE: no DOM, no Web Audio, no Blob — it emits a plain
// ArrayBuffer the caller can wrap however it likes (Blob, download, worker
// message). This is an internal API fed by our own capture path, so malformed
// input (mismatched channel lengths) throws rather than being silently coerced.

import { clampNumber } from '../audio/contracts'

export type BitDepth = 16 | 24

export interface WavEncodeOptions {
  sampleRate: number
  /** 16 (CD) or 24 (studio). Defaults to 16. */
  bitDepth?: BitDepth
}

// Full-scale integer for each depth: 2^(bits-1) - 1. Scaling by the positive
// max (not 2^(bits-1)) keeps +1.0 exactly at full-scale and -1.0 symmetric,
// so neither rail can wrap past the signed range.
const FULL_SCALE: Record<BitDepth, number> = { 16: 32767, 24: 8388607 }

/**
 * Interleave `channels` (mono/stereo/N>=1) and encode as PCM WAV.
 * All channels must share the same length.
 */
export function encodeWav(channels: Float32Array[], opts: WavEncodeOptions): ArrayBuffer {
  const numChannels = channels.length
  if (numChannels < 1) {
    throw new Error('encodeWav: at least one channel is required')
  }

  const frames = channels[0].length
  for (let c = 1; c < numChannels; c++) {
    if (channels[c].length !== frames) {
      throw new Error(
        `encodeWav: channel ${c} has ${channels[c].length} samples, expected ${frames} to match channel 0`,
      )
    }
  }

  const bitDepth: BitDepth = opts.bitDepth ?? 16
  const bytesPerSample = bitDepth / 8
  const blockAlign = numChannels * bytesPerSample
  const byteRate = opts.sampleRate * blockAlign
  const dataSize = frames * blockAlign

  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  // --- 44-byte canonical header ---
  writeTag(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true) // chunkSize = header-after-this + data
  writeTag(view, 8, 'WAVE')
  writeTag(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size for PCM
  view.setUint16(20, 1, true) // audioFormat = 1 (PCM)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, opts.sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitDepth, true)
  writeTag(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  // --- interleaved sample data (L,R,L,R,... for stereo) ---
  const fullScale = FULL_SCALE[bitDepth]
  let offset = 44
  if (bitDepth === 16) {
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < numChannels; c++) {
        view.setInt16(offset, quantize(channels[c][f], fullScale), true)
        offset += 2
      }
    }
  } else {
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < numChannels; c++) {
        writeInt24(view, offset, quantize(channels[c][f], fullScale))
        offset += 3
      }
    }
  }

  return buffer
}

/** Clamp to [-1,1] (NaN -> 0) then round to the nearest integer sample. */
function quantize(sample: number, fullScale: number): number {
  return Math.round(clampNumber(sample, -1, 1, 0) * fullScale)
}

function writeTag(view: DataView, offset: number, tag: string): void {
  for (let i = 0; i < tag.length; i++) {
    view.setUint8(offset + i, tag.charCodeAt(i))
  }
}

/** Write a signed 24-bit little-endian sample as three bytes (two's complement). */
function writeInt24(view: DataView, offset: number, value: number): void {
  const v = value < 0 ? value + 0x1000000 : value
  view.setUint8(offset, v & 0xff)
  view.setUint8(offset + 1, (v >> 8) & 0xff)
  view.setUint8(offset + 2, (v >> 16) & 0xff)
}
