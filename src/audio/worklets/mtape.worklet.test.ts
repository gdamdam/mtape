// Regression tests for the real-time worklet, driven through workletTestHarness.
// The worklet's process() path is allocation-free in steady state, so the
// assertions here are deterministic at the sample/frame level (fixed tempo,
// sample rate, and quantum size — no wall-clock, no randomness).

import { describe, expect, it, vi } from 'vitest'
import { createHarness, type Harness } from './workletTestHarness'
import type { ClipPlacement, TrackArrangement } from '../messages'

// ---------------------------------------------------------------- fixtures

function track(overrides: Partial<TrackArrangement> = {}): TrackArrangement {
  return {
    trackId: 't1',
    gainDb: 0,
    pan: 0,
    mute: false,
    solo: false,
    armed: false,
    monitor: false,
    eq: { lowDb: 0, midDb: 0, highDb: 0 },
    tape: { enabled: false, saturation: 0, wowFlutter: 0 },
    clips: [],
    ...overrides,
  }
}

function clip(audioId: string, overrides: Partial<ClipPlacement> = {}): ClipPlacement {
  return { clipId: 'c1', audioId, startSec: 0, offsetSec: 0, durationSec: 100, gainDb: 0, fadeInSec: 0, fadeOutSec: 0, ...overrides }
}

/** Run N quanta of `len` frames, returning the concatenated left output. */
function runL(h: Harness, quanta: number, len: number, input: Float32Array[] | null = null): Float32Array {
  const out = new Float32Array(quanta * len)
  for (let i = 0; i < quanta; i++) out.set(h.process(input, len).outL, i * len)
  return out
}

/** Onset frame of each metronome click: the first above-threshold sample after a
 *  silent gap. Clicks are ~24000 frames apart while a click's own sine only dips
 *  below threshold for a few dozen samples, so a 2000-frame separation isolates
 *  one onset per click without splitting a click. */
function clickOnsets(out: Float32Array, separation = 2000): number[] {
  const thresh = 0.005
  const onsets: number[] = []
  let prevActive = -Infinity
  for (let i = 0; i < out.length; i++) {
    if (Math.abs(out[i]) > thresh) {
      if (i - prevActive > separation) onsets.push(i)
      prevActive = i
    }
  }
  return onsets
}

/** Sum of squares over [start, start+len) — used to assert a click is (or is not)
 *  present in a specific window without depending on its sub-sample onset. */
function energy(out: Float32Array, start: number, len: number): number {
  let e = 0
  for (let i = start; i < start + len && i < out.length; i++) e += out[i] * out[i]
  return e
}

const near = (a: number, b: number, tol = 150): boolean => Math.abs(a - b) <= tol

// ============================================================ #5 metronome

describe('#5 metronome click grid', () => {
  // tempo 120 / 4/4 @ 48000 → 0.5 s/beat = 24000 frames per beat.
  const SR = 48000
  const FPB = 24000

  it('fires exactly one click per beat boundary during plain playback', async () => {
    const h = await createHarness({ sampleRate: SR })
    h.send({ type: 'setMetronome', enabled: true, countInBars: 0 })
    h.send({ type: 'transport', action: 'play' })
    const out = runL(h, 469, 128) // ~60032 frames → beats at 0, 24000, 48000
    const onsets = clickOnsets(out)
    expect(onsets.length).toBe(3)
    expect(near(onsets[0], 0)).toBe(true)
    expect(near(onsets[1], FPB)).toBe(true)
    expect(near(onsets[2], 2 * FPB)).toBe(true)
  })

  it('hands off count-in → play with a fresh downbeat click and no gap/overlap', async () => {
    const h = await createHarness({ sampleRate: SR })
    h.send({ type: 'setMetronome', enabled: true, countInBars: 1 })
    h.send({ type: 'transport', action: 'record' }) // 1 bar = 96000 frames of count-in
    const out = runL(h, 1032, 128) // 132096 frames: 4 count-in beats + play beats
    const onsets = clickOnsets(out)
    // Count-in clicks at 0/24000/48000/72000, then the play-phase handoff must
    // re-fire beat 0 at exactly 96000 (line 307 re-latches lastBeat to -1), then
    // the next play beat at 120000.
    expect(onsets.length).toBe(6)
    ;[0, 24000, 48000, 72000, 96000, 120000].forEach((f, i) => expect(near(onsets[i], f)).toBe(true))
  })

  it('does NOT fire a spurious click at a loop seam that lands between beats (M4)', async () => {
    const h = await createHarness({ sampleRate: SR })
    h.send({ type: 'setMetronome', enabled: true, countInBars: 0 })
    h.send({ type: 'setLoop', loop: { enabled: true, startSec: 0, endSec: 0.6 } }) // seam @ 28800 (mid-beat)
    h.send({ type: 'transport', action: 'play' })
    const out = runL(h, 469, 128)
    // Real beats: 0 and 24000 (inside the loop) each click.
    expect(energy(out, 0, 1440)).toBeGreaterThan(0.01)
    expect(energy(out, FPB, 1440)).toBeGreaterThan(0.01)
    // The seam at 28800 (and 57600) is NOT a beat — the re-latch must keep it silent.
    expect(energy(out, 28800, 1440)).toBeLessThan(1e-6)
    expect(energy(out, 57600, 1440)).toBeLessThan(1e-6)
  })

  it('does NOT double-click when the loop seam lands exactly on a beat', async () => {
    const h = await createHarness({ sampleRate: SR })
    h.send({ type: 'setMetronome', enabled: true, countInBars: 0 })
    h.send({ type: 'setLoop', loop: { enabled: true, startSec: 0, endSec: 1.0 } }) // seam @ 48000 (== beat 2)
    h.send({ type: 'transport', action: 'play' })
    const out = runL(h, 704, 128) // ~90112 frames, seam on a 128-quantum boundary
    const onsets = clickOnsets(out)
    // beat 0 (0), beat 1 (24000), wrap suppresses the re-entry downbeat, next
    // beat 1 of the 2nd pass at 72000. No extra click at the 48000 seam.
    expect(onsets.length).toBe(3)
    ;[0, 24000, 72000].forEach((f, i) => expect(near(onsets[i], f)).toBe(true))
    expect(energy(out, 48000, 1440)).toBeLessThan(1e-6)
  })

  it('fires only the initial click for a loop shorter than one beat', async () => {
    const h = await createHarness({ sampleRate: SR })
    h.send({ type: 'setMetronome', enabled: true, countInBars: 0 })
    h.send({ type: 'setLoop', loop: { enabled: true, startSec: 0, endSec: 0.25 } }) // 12000 frames < FPB
    h.send({ type: 'transport', action: 'play' })
    const out = runL(h, 469, 128)
    const onsets = clickOnsets(out)
    expect(onsets.length).toBe(1)
    expect(near(onsets[0], 0)).toBe(true)
  })

  it('entered via seek: latches the beat so no off-grid click fires at the seek target (M15)', async () => {
    const h = await createHarness({ sampleRate: SR })
    h.send({ type: 'setMetronome', enabled: true, countInBars: 0 })
    h.send({ type: 'seek', positionSec: 0.75 }) // frame 36000, mid-beat-1
    h.send({ type: 'transport', action: 'play' })
    const out = runL(h, 469, 128)
    const onsets = clickOnsets(out)
    // No click at output 0 — the seek landed mid-beat and lastBeat was latched.
    // First click when the playhead crosses the next beat: 48000 → output 12000.
    expect(onsets[0]).toBeGreaterThan(5000)
    expect(near(onsets[0], 12000)).toBe(true)
    expect(near(onsets[1], 36000)).toBe(true) // beat @ posFrame 72000
  })
})

// ============================================================ #4 recorder

describe('#4 recorder capture', () => {
  const SR = 256 // capacity == round(sampleRate) == 256 frames per chunk

  async function recordTake(nFrames: number): Promise<Harness> {
    const h = await createHarness({ sampleRate: SR })
    h.send({ type: 'setArrangement', tracks: [track({ armed: true })] })
    h.send({ type: 'transport', action: 'record' })
    const input = new Float32Array(128).fill(0.7)
    let captured = 0
    while (captured < nFrames) {
      const len = Math.min(128, nFrames - captured)
      h.process([input.subarray(0, len)], len)
      captured += len
    }
    h.send({ type: 'transport', action: 'stop' })
    return h
  }

  for (const n of [200, 256, 257]) {
    it(`chunk frame lengths sum to recTotalFrames for a ${n}-frame take`, async () => {
      const h = await recordTake(n)
      const chunks = h.events('recordChunk')
      const complete = h.events('recordComplete')
      const sum = chunks.reduce((s, c) => s + c.channels[0].length, 0)
      expect(sum).toBe(n)
      expect(complete.length).toBe(1)
      expect(Math.round(complete[0].durationSec * SR)).toBe(n)
    })
  }

  it('posts every recordChunk before the single recordComplete', async () => {
    const h = await recordTake(600)
    const types = h.posted.map((m) => m.data.type).filter((t) => t === 'recordChunk' || t === 'recordComplete')
    expect(types.at(-1)).toBe('recordComplete')
    expect(types.slice(0, -1).every((t) => t === 'recordChunk')).toBe(true)
  })

  it('a zero-capture take (nothing armed) still emits recordComplete and leaks no id', async () => {
    const h = await createHarness({ sampleRate: SR })
    h.send({ type: 'setArrangement', tracks: [track({ armed: false })] })
    h.send({ type: 'transport', action: 'record' })
    const input = new Float32Array(128).fill(0.7)
    for (let i = 0; i < 4; i++) h.process([input], 128) // signal present, but nothing armed
    h.send({ type: 'transport', action: 'stop' })
    const complete = h.events('recordComplete')
    expect(complete.length).toBe(1) // FIFO id can be retired on the main thread
    expect(complete[0].durationSec).toBe(0)
    expect(h.events('recordChunk').length).toBe(0)
  })

  it('a zero-capture take (armed, but no input ever delivered) still emits recordComplete', async () => {
    const h = await createHarness({ sampleRate: SR })
    h.send({ type: 'setArrangement', tracks: [track({ armed: true })] })
    h.send({ type: 'transport', action: 'record' })
    for (let i = 0; i < 4; i++) h.process([], 128) // empty input quanta — recStarted never latches
    h.send({ type: 'transport', action: 'stop' })
    const complete = h.events('recordComplete')
    expect(complete.length).toBe(1)
    expect(complete[0].durationSec).toBe(0)
    expect(h.events('recordChunk').length).toBe(0)
  })

  it('defers the channel-count latch (and start frame) to the first non-empty quantum (L5)', async () => {
    const h = await createHarness({ sampleRate: 48000 })
    h.send({ type: 'setArrangement', tracks: [track({ armed: true })] })
    h.send({ type: 'transport', action: 'record' })
    h.process([], 128) // empty first quantum: advances posFrame 128, no latch, still mono default
    const stereo = [new Float32Array(128).fill(0.5), new Float32Array(128).fill(-0.5)]
    for (let i = 0; i < 3; i++) h.process(stereo, 128)
    h.send({ type: 'transport', action: 'stop' })
    const chunks = h.events('recordChunk')
    const complete = h.events('recordComplete')
    expect(chunks[0].channels.length).toBe(2) // latched to the stereo input, not forced mono
    expect(Math.round(complete[0].startSec * 48000)).toBe(128) // deferred past the empty quantum
    expect(Math.round(complete[0].durationSec * 48000)).toBe(3 * 128)
  })

  it('does not allocate per quantum: allocChunk fires only at ~1s chunk boundaries', async () => {
    const h = await createHarness({ sampleRate: SR }) // capacity 256
    h.send({ type: 'setArrangement', tracks: [track({ armed: true })] })
    const spy = vi.fn()
    const orig = h.proc.allocChunk.bind(h.proc)
    h.proc.allocChunk = (...a: unknown[]) => {
      spy()
      return orig(...a)
    }
    h.send({ type: 'transport', action: 'record' })
    const input = new Float32Array(128).fill(0.5)
    for (let i = 0; i < 8; i++) h.process([input], 128) // 1024 frames over 8 quanta
    h.send({ type: 'transport', action: 'stop' })
    // 1 latch alloc + 3 mid-capture flush allocs (at 256/512/768) = 4, NOT 8.
    expect(spy).toHaveBeenCalledTimes(4)
    expect(h.events('recordChunk').length).toBe(4)
    expect(spy.mock.calls.length).toBeLessThan(8)
  })

  it('is idempotent across repeated stop() — no double recordComplete', async () => {
    const h = await recordTake(300)
    h.send({ type: 'transport', action: 'stop' }) // second stop while not recording
    h.send({ type: 'transport', action: 'stop' })
    expect(h.events('recordComplete').length).toBe(1)
  })
})

// ============================================================ #6 meters

describe('#6 master meters', () => {
  function lastMeters(h: Harness) {
    return h.events('meters').at(-1)!
  }

  it('reads exactly 0 while stopped after a single telemetry post (no decay tail)', async () => {
    const h = await createHarness({ sampleRate: 48000 })
    runL(h, 8, 128) // 1024 frames → one post, transport never started
    const m = lastMeters(h)
    expect(m.masterPeakL).toBe(0)
    expect(m.masterPeakR).toBe(0)
    expect(m.masterRms).toBe(0)
    expect(m.clip).toBe(false)
  })

  it('drops back to 0 in one post after playback stops (no dilution / long release)', async () => {
    const h = await createHarness({ sampleRate: 48000 })
    h.send({ type: 'loadAudio', audioId: 'a', channels: [new Float32Array(48000).fill(0.5)], sampleRate: 48000 })
    h.send({ type: 'setArrangement', tracks: [track({ pan: -1, clips: [clip('a')] })] })
    h.send({ type: 'transport', action: 'play' })
    runL(h, 8, 128)
    expect(lastMeters(h).masterPeakL).toBeGreaterThan(0.4)
    h.send({ type: 'transport', action: 'stop' })
    runL(h, 8, 128)
    expect(lastMeters(h).masterPeakL).toBe(0)
    expect(lastMeters(h).masterRms).toBe(0)
  })

  it('does not dilute masterRms with stopped frames inside one metering window (F5)', async () => {
    const h = await createHarness({ sampleRate: 48000 })
    h.send({ type: 'loadAudio', audioId: 'a', channels: [new Float32Array(48000).fill(0.5)], sampleRate: 48000 })
    h.send({ type: 'setArrangement', tracks: [track({ pan: -1, clips: [clip('a')] })] })
    h.send({ type: 'transport', action: 'play' })
    runL(h, 4, 128) // 512 played frames — half of the 1024-frame window
    h.send({ type: 'transport', action: 'stop' })
    runL(h, 4, 128) // 512 stopped frames complete the window and trigger the post
    // Only the played half may count: sqrt(0.5^2 / 2ch), not diluted to 0.25 by
    // the 512 silent stopped frames.
    expect(lastMeters(h).masterRms).toBeCloseTo(Math.sqrt(0.125), 3)
  })

  for (const SR of [44100, 48000]) {
    for (const Q of [128, 512]) {
      it(`peak/RMS are stable & correct at ${SR}Hz, ${Q}-frame quanta`, async () => {
        const h = await createHarness({ sampleRate: SR })
        h.send({ type: 'loadAudio', audioId: 'a', channels: [new Float32Array(SR).fill(0.5)], sampleRate: SR })
        h.send({ type: 'setArrangement', tracks: [track({ pan: -1, clips: [clip('a')] })] })
        h.send({ type: 'transport', action: 'play' })
        runL(h, Math.ceil(2048 / Q), Q)
        const m = lastMeters(h)
        expect(m.masterPeakL).toBeCloseTo(0.5, 3) // constant 0.5, hard left, under the limiter ceiling
        expect(m.masterPeakR).toBeCloseTo(0, 3)
        expect(m.masterRms).toBeCloseTo(Math.sqrt(0.125), 3) // (0.5^2 on L only) / 2 channels
      })
    }
  }

  it('latches the clip LED across posts (peak resets, clip holds) and clears on stop', async () => {
    const h = await createHarness({ sampleRate: 48000 })
    h.send({ type: 'setMaster', master: { gainDb: 0, drive: 0, limiterCeilingDb: 0, varispeed: 1 } }) // ceiling 1.0
    h.send({ type: 'loadAudio', audioId: 'a', channels: [new Float32Array(48000).fill(1.0)], sampleRate: 48000 })
    h.send({ type: 'setArrangement', tracks: [track({ pan: -1, clips: [clip('a')] })] })
    h.send({ type: 'transport', action: 'play' })
    runL(h, 8, 128)
    const clipped = lastMeters(h)
    expect(clipped.masterPeakL).toBeGreaterThanOrEqual(0.999)
    expect(clipped.clip).toBe(true)

    // Silence the signal: the window peak returns to 0, but the latch must hold.
    h.send({ type: 'setArrangement', tracks: [] })
    runL(h, 8, 128)
    const held = lastMeters(h)
    expect(held.masterPeakL).toBe(0)
    expect(held.clip).toBe(true) // held despite the peak decaying to 0

    // Transport stop clears the latch.
    h.send({ type: 'transport', action: 'stop' })
    runL(h, 8, 128)
    expect(lastMeters(h).clip).toBe(false)
  })
})
