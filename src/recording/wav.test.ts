import { describe, expect, it } from 'vitest'
import { encodeWav } from './wav'

// --- local byte-level readers (parse the encoder's output back) ---

function readTag(view: DataView, offset: number): string {
  let s = ''
  for (let i = 0; i < 4; i++) s += String.fromCharCode(view.getUint8(offset + i))
  return s
}

/** Read one signed 24-bit LE sample and sign-extend to a JS number. */
function readInt24(view: DataView, offset: number): number {
  const b0 = view.getUint8(offset)
  const b1 = view.getUint8(offset + 1)
  const b2 = view.getUint8(offset + 2)
  const raw = b0 | (b1 << 8) | (b2 << 16)
  return raw & 0x800000 ? raw - 0x1000000 : raw
}

interface Header {
  view: DataView
  chunkSize: number
  audioFormat: number
  numChannels: number
  sampleRate: number
  byteRate: number
  blockAlign: number
  bitsPerSample: number
  dataSize: number
}

function parseHeader(buffer: ArrayBuffer): Header {
  const view = new DataView(buffer)
  expect(readTag(view, 0)).toBe('RIFF')
  expect(readTag(view, 8)).toBe('WAVE')
  expect(readTag(view, 12)).toBe('fmt ')
  expect(readTag(view, 36)).toBe('data')
  expect(view.getUint32(16, true)).toBe(16) // PCM fmt chunk size
  return {
    view,
    chunkSize: view.getUint32(4, true),
    audioFormat: view.getUint16(20, true),
    numChannels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    dataSize: view.getUint32(40, true),
  }
}

describe('encodeWav header', () => {
  const cases = [
    { label: 'mono 16-bit', chans: 1, bitDepth: 16 as const },
    { label: 'stereo 16-bit', chans: 2, bitDepth: 16 as const },
    { label: 'mono 24-bit', chans: 1, bitDepth: 24 as const },
    { label: 'stereo 24-bit', chans: 2, bitDepth: 24 as const },
  ]

  for (const { label, chans, bitDepth } of cases) {
    it(`is correct for ${label}`, () => {
      const frames = 5
      const channels = Array.from({ length: chans }, () => new Float32Array(frames))
      const h = parseHeader(encodeWav(channels, { sampleRate: 44100, bitDepth }))

      const bytesPerSample = bitDepth / 8
      const blockAlign = chans * bytesPerSample
      expect(h.audioFormat).toBe(1)
      expect(h.numChannels).toBe(chans)
      expect(h.sampleRate).toBe(44100)
      expect(h.bitsPerSample).toBe(bitDepth)
      expect(h.blockAlign).toBe(blockAlign)
      expect(h.byteRate).toBe(44100 * blockAlign)
      const dataSize = frames * blockAlign
      expect(h.dataSize).toBe(dataSize) // data field is the unpadded sample count
      expect(h.chunkSize).toBe(36 + dataSize + (dataSize & 1)) // RIFF size counts any pad byte
    })
  }

  it('defaults to 16-bit when bitDepth is omitted', () => {
    const h = parseHeader(encodeWav([new Float32Array(3)], { sampleRate: 48000 }))
    expect(h.bitsPerSample).toBe(16)
    expect(h.blockAlign).toBe(2)
  })

  it('total byteLength = 44 + frames*blockAlign', () => {
    const frames = 10
    const buf = encodeWav([new Float32Array(frames), new Float32Array(frames)], {
      sampleRate: 44100,
      bitDepth: 24,
    })
    expect(buf.byteLength).toBe(44 + frames * (2 * 3))
  })

  it('word-aligns an odd-sized data chunk with a trailing zero pad byte [L1]', () => {
    // 24-bit mono, 3 frames -> dataSize = 9 (odd). RIFF requires an even chunk,
    // so a pad byte follows the data. The pad counts in the RIFF size but not
    // the data chunk's own size field.
    const buf = encodeWav([new Float32Array(3)], { sampleRate: 44100, bitDepth: 24 })
    const view = new DataView(buf)
    expect(view.getUint32(40, true)).toBe(9) // data chunk size = actual samples
    expect(buf.byteLength).toBe(44 + 9 + 1) // header + data + pad
    expect(view.getUint32(4, true)).toBe(36 + 9 + 1) // RIFF size counts the pad
    expect(buf.byteLength % 2).toBe(0) // whole file word-aligned
    expect(view.getUint8(buf.byteLength - 1)).toBe(0) // pad byte is zero
  })

  it('does not pad an already-even data chunk', () => {
    // 24-bit mono, 2 frames -> dataSize = 6 (even): no pad.
    const buf = encodeWav([new Float32Array(2)], { sampleRate: 44100, bitDepth: 24 })
    const view = new DataView(buf)
    expect(buf.byteLength).toBe(44 + 6)
    expect(view.getUint32(4, true)).toBe(36 + 6)
  })
})

describe('encodeWav round-trip', () => {
  const known = [0, 1, -1, 0.5]

  it('16-bit decodes within quantization tolerance', () => {
    const buf = encodeWav([Float32Array.from(known)], { sampleRate: 44100, bitDepth: 16 })
    const view = new DataView(buf)
    // 1 LSB at 16-bit full-scale (32767).
    const tol = 1 / 32767
    known.forEach((expected, i) => {
      const decoded = view.getInt16(44 + i * 2, true) / 32767
      expect(decoded).toBeCloseTo(expected, 3)
      expect(Math.abs(decoded - expected)).toBeLessThanOrEqual(tol + 1e-9)
    })
  })

  it('24-bit decodes within quantization tolerance', () => {
    const buf = encodeWav([Float32Array.from(known)], { sampleRate: 44100, bitDepth: 24 })
    const view = new DataView(buf)
    const tol = 1 / 8388607
    known.forEach((expected, i) => {
      const decoded = readInt24(view, 44 + i * 3) / 8388607
      expect(decoded).toBeCloseTo(expected, 5)
      expect(Math.abs(decoded - expected)).toBeLessThanOrEqual(tol + 1e-9)
    })
  })

  it('maps +1.0 and -1.0 exactly to full-scale (16-bit)', () => {
    const buf = encodeWav([Float32Array.from([1, -1])], { sampleRate: 44100 })
    const view = new DataView(buf)
    expect(view.getInt16(44, true)).toBe(32767)
    expect(view.getInt16(46, true)).toBe(-32767)
  })
})

describe('encodeWav interleaving', () => {
  it('writes stereo samples as L,R,L,R', () => {
    const left = Float32Array.from([1, 0.5])
    const right = Float32Array.from([-1, -0.5])
    const view = new DataView(encodeWav([left, right], { sampleRate: 44100 }))
    // frame 0: L then R, frame 1: L then R
    expect(view.getInt16(44, true)).toBe(32767) // L[0]
    expect(view.getInt16(46, true)).toBe(-32767) // R[0]
    expect(view.getInt16(48, true)).toBe(Math.round(0.5 * 32767)) // L[1]
    expect(view.getInt16(50, true)).toBe(Math.round(-0.5 * 32767)) // R[1]
  })
})

describe('encodeWav clipping', () => {
  it('clamps out-of-range values to full-scale without wrapping (16-bit)', () => {
    const buf = encodeWav([Float32Array.from([2, -2, 1.0001, -1.0001])], { sampleRate: 44100 })
    const view = new DataView(buf)
    expect(view.getInt16(44, true)).toBe(32767)
    expect(view.getInt16(46, true)).toBe(-32767)
    expect(view.getInt16(48, true)).toBe(32767)
    expect(view.getInt16(50, true)).toBe(-32767)
  })

  it('clamps out-of-range values to full-scale without wrapping (24-bit)', () => {
    const buf = encodeWav([Float32Array.from([5, -5])], { sampleRate: 44100, bitDepth: 24 })
    const view = new DataView(buf)
    expect(readInt24(view, 44)).toBe(8388607)
    expect(readInt24(view, 47)).toBe(-8388607)
  })

  it('coerces NaN to silence', () => {
    const view = new DataView(encodeWav([Float32Array.from([NaN])], { sampleRate: 44100 }))
    expect(view.getInt16(44, true)).toBe(0)
  })
})

describe('encodeWav validation', () => {
  it('throws on unequal channel lengths', () => {
    expect(() =>
      encodeWav([new Float32Array(4), new Float32Array(3)], { sampleRate: 44100 }),
    ).toThrow(/channel 1 has 3 samples/)
  })

  it('throws when no channels are supplied', () => {
    expect(() => encodeWav([], { sampleRate: 44100 })).toThrow(/at least one channel/)
  })

  it('throws on non-positive-integer sample rates [L9]', () => {
    const chans = [new Float32Array(4)]
    expect(() => encodeWav(chans, { sampleRate: 0 })).toThrow(/sampleRate must be a positive integer/)
    expect(() => encodeWav(chans, { sampleRate: -44100 })).toThrow(/sampleRate must be a positive integer/)
    expect(() => encodeWav(chans, { sampleRate: NaN })).toThrow(/sampleRate must be a positive integer/)
    expect(() => encodeWav(chans, { sampleRate: 44100.5 })).toThrow(/sampleRate must be a positive integer/)
    expect(() => encodeWav(chans, { sampleRate: Infinity })).toThrow(/sampleRate must be a positive integer/)
  })

  it('supports N>=1 channels (e.g. 3-channel)', () => {
    const h = parseHeader(
      encodeWav([new Float32Array(2), new Float32Array(2), new Float32Array(2)], {
        sampleRate: 44100,
      }),
    )
    expect(h.numChannels).toBe(3)
    expect(h.blockAlign).toBe(6)
  })
})
