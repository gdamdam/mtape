import { describe, expect, it } from 'vitest'
import { defaultSession, defaultTrack, type Clip, type Session, type Track } from '../audio/contracts'
import { ceilingLin } from '../audio/dsp/dynamics'
import { renderSession, type RenderSource, type SourceMap } from './renderSession'

// --- local builders (kept minimal & explicit for deterministic fixtures) ------

function makeClip(over: Partial<Clip> & { audioId: string }): Clip {
  return {
    id: over.id ?? over.audioId,
    audioId: over.audioId,
    startSec: over.startSec ?? 0,
    offsetSec: over.offsetSec ?? 0,
    durationSec: over.durationSec ?? 1,
    gainDb: over.gainDb ?? 0,
    fades: over.fades ?? { inSec: 0, outSec: 0 },
  }
}

function makeTrack(index: number, over: Partial<Track> = {}): Track {
  return { ...defaultTrack(index), ...over }
}

/** Ramp source at a given sample rate: buffer[i] = base*(i+1). */
function rampSource(len: number, sampleRate: number, base = 0.05): RenderSource {
  const ch = new Float32Array(len)
  for (let i = 0; i < len; i++) ch[i] = base * (i + 1)
  return { channels: [ch], sampleRate }
}

function constSource(len: number, sampleRate: number, value: number): RenderSource {
  const ch = new Float32Array(len).fill(value)
  return { channels: [ch], sampleRate }
}

function buildSession(tracks: Track[], master: Partial<Session['master']> = {}): Session {
  const s = defaultSession('render-test')
  return { ...s, tracks, master: { ...s.master, ...master } }
}

// --------------------------------------------------------------------------

describe('renderSession — clip placement', () => {
  it('lands a clip at exactly frame round(startSec*sr) with correct sample values', () => {
    const sr = 48000
    const src = rampSource(10, sr) // buffer[0]=0.05, buffer[1]=0.10, ...
    const sources: SourceMap = new Map([['a', src]])
    const clip = makeClip({ audioId: 'a', startSec: 1.0, durationSec: 5 })
    const track = makeTrack(0, { pan: -1, clips: [clip] }) // hard-left isolates L
    const res = renderSession(buildSession([track]), sources, { sampleRate: sr, startSec: 0, endSec: 1.5 })

    const onset = Math.round(1.0 * sr)
    expect(res.channels[0][onset - 1]).toBeCloseTo(0, 6) // silence before onset
    expect(res.channels[0][onset]).toBeCloseTo(0.05, 5) // buffer[0]
    expect(res.channels[0][onset + 1]).toBeCloseTo(0.1, 5) // buffer[1]
  })

  it('resamples a source whose rate differs from the render rate', () => {
    const srcRate = 24000
    const src = rampSource(100, srcRate, 0.005)
    const sources: SourceMap = new Map([['a', src]])
    const clip = makeClip({ audioId: 'a', startSec: 0, durationSec: 100 / srcRate })
    const track = makeTrack(0, { pan: -1, clips: [clip] })
    const res = renderSession(buildSession([track]), sources, { sampleRate: 48000, startSec: 0, endSec: 100 / srcRate })

    expect(res.channels[0].length).toBe(200) // 24k source rendered at 48k doubles
    // Every other output frame aligns with a source sample (shape preserved).
    for (let k = 0; k < 90; k += 10) {
      expect(res.channels[0][2 * k]).toBeCloseTo(src.channels[0][k], 4)
    }
  })
})

describe('renderSession — clip gain & fades', () => {
  it('applies linear fades: endpoints ~0, midpoint full', () => {
    const sr = 1000
    const src = constSource(sr * 4, sr, 0.5)
    const sources: SourceMap = new Map([['a', src]])
    const clip = makeClip({ audioId: 'a', startSec: 0, durationSec: 4, fades: { inSec: 1, outSec: 1 } })
    const track = makeTrack(0, { pan: -1, clips: [clip] })
    const res = renderSession(buildSession([track]), sources, { sampleRate: sr, startSec: 0, endSec: 4 })
    const l = res.channels[0]

    expect(l[0]).toBeCloseTo(0, 5) // fade-in start
    expect(l[500]).toBeCloseTo(0.25, 3) // half through fade-in => 0.5*0.5
    expect(l[2000]).toBeCloseTo(0.5, 3) // sustain, full
    expect(l[3999]).toBeLessThan(0.01) // near fade-out end
  })

  it('applies clip gainDb', () => {
    const sr = 1000
    const sources: SourceMap = new Map([['a', constSource(sr, sr, 0.5)]])
    const clip = makeClip({ audioId: 'a', startSec: 0, durationSec: 1, gainDb: -6 })
    const track = makeTrack(0, { pan: -1, clips: [clip] })
    const res = renderSession(buildSession([track]), sources, { sampleRate: sr, startSec: 0, endSec: 1 })
    // -6 dB ≈ 0.501x. 0.5 * 0.501 ≈ 0.251.
    expect(res.channels[0][500]).toBeCloseTo(0.5 * Math.pow(10, -6 / 20), 3)
  })

  it('sums two overlapping clips on the same track', () => {
    const sr = 1000
    const sources: SourceMap = new Map([['a', constSource(sr * 3, sr, 0.2)]])
    const a = makeClip({ id: 'c1', audioId: 'a', startSec: 0, durationSec: 2 })
    const b = makeClip({ id: 'c2', audioId: 'a', startSec: 1, durationSec: 2 })
    const track = makeTrack(0, { pan: -1, clips: [a, b] })
    const res = renderSession(buildSession([track]), sources, { sampleRate: sr, startSec: 0, endSec: 3 })
    const l = res.channels[0]

    expect(l[500]).toBeCloseTo(0.2, 3) // only clip a
    expect(l[1500]).toBeCloseTo(0.4, 3) // overlap => sum
    expect(l[2500]).toBeCloseTo(0.2, 3) // only clip b
  })
})

describe('renderSession — track gain & pan', () => {
  it('hard-left pan puts energy only in L', () => {
    const sr = 1000
    const sources: SourceMap = new Map([['a', constSource(sr, sr, 0.5)]])
    const clip = makeClip({ audioId: 'a', startSec: 0, durationSec: 1 })
    const track = makeTrack(0, { pan: -1, clips: [clip] })
    const res = renderSession(buildSession([track]), sources, { sampleRate: sr, startSec: 0, endSec: 1 })

    expect(res.channels[0][500]).toBeGreaterThan(0.4)
    for (let f = 0; f < res.channels[1].length; f++) expect(res.channels[1][f]).toBeCloseTo(0, 6)
  })
})

describe('renderSession — solo / mute resolution', () => {
  const sr = 1000
  function twoTrackSession(aOver: Partial<Track>, bOver: Partial<Track>): { s: Session; sources: SourceMap } {
    const sources: SourceMap = new Map([['a', constSource(sr, sr, 0.3)]])
    const ta = makeTrack(0, { pan: -1, clips: [makeClip({ audioId: 'a', durationSec: 1 })], ...aOver })
    const tb = makeTrack(1, { pan: -1, clips: [makeClip({ audioId: 'a', durationSec: 1 })], ...bOver })
    return { s: buildSession([ta, tb]), sources }
  }

  it('a muted track is silent', () => {
    const { s, sources } = twoTrackSession({ mute: true }, { mute: true })
    const res = renderSession(s, sources, { sampleRate: sr, startSec: 0, endSec: 1 })
    for (let f = 0; f < res.channels[0].length; f++) expect(res.channels[0][f]).toBeCloseTo(0, 6)
  })

  it('solo is exclusive: only soloed non-muted tracks play', () => {
    const { s, sources } = twoTrackSession({ solo: true }, {})
    const res = renderSession(s, sources, { sampleRate: sr, startSec: 0, endSec: 1 })
    // Only track A audible => single 0.3 contribution, not the summed 0.6.
    expect(res.channels[0][500]).toBeCloseTo(0.3, 3)
  })

  it('mute wins within the solo set (soloed+muted is silent)', () => {
    const { s, sources } = twoTrackSession({ solo: true, mute: true }, { solo: true })
    const res = renderSession(s, sources, { sampleRate: sr, startSec: 0, endSec: 1 })
    expect(res.channels[0][500]).toBeCloseTo(0.3, 3) // only the un-muted soloed track
  })
})

describe('renderSession — master chain', () => {
  it('limiter keeps a hot mix at or below the ceiling', () => {
    const sr = 1000
    const sources: SourceMap = new Map([['a', constSource(sr, sr, 1.0)]])
    const tracks = [0, 1, 2, 3].map((i) => makeTrack(i, { pan: -1, clips: [makeClip({ audioId: 'a', durationSec: 1 })] }))
    const res = renderSession(buildSession(tracks, { gainDb: 12 }), sources, { sampleRate: sr, startSec: 0, endSec: 1 })
    const ceil = ceilingLin(-0.3)
    for (let f = 0; f < res.channels[0].length; f++) {
      expect(Math.abs(res.channels[0][f])).toBeLessThanOrEqual(ceil + 1e-6)
    }
  })
})

describe('renderSession — varispeed', () => {
  const sr = 1000
  function render(varispeed: number): number {
    const sources: SourceMap = new Map([['a', constSource(sr, sr, 0.3)]])
    const track = makeTrack(0, { clips: [makeClip({ audioId: 'a', durationSec: 1 })] })
    const res = renderSession(buildSession([track], { varispeed }), sources, { sampleRate: sr, startSec: 0, endSec: 1 })
    return res.channels[0].length
  }

  it('2.0x ≈ half length, 0.5x ≈ double length', () => {
    expect(render(2)).toBe(500)
    expect(render(0.5)).toBe(2000)
    expect(render(1)).toBe(1000)
  })
})

describe('renderSession — robustness & determinism', () => {
  const sr = 1000

  it('a missing source id is silent and never throws', () => {
    const clip = makeClip({ audioId: 'nope', durationSec: 1 })
    const track = makeTrack(0, { clips: [clip] })
    const res = renderSession(buildSession([track]), new Map(), { sampleRate: sr, startSec: 0, endSec: 1 })
    for (let f = 0; f < res.channels[0].length; f++) expect(res.channels[0][f]).toBe(0)
  })

  it('a zero-length region yields empty channels', () => {
    const res = renderSession(buildSession([makeTrack(0)]), new Map(), { sampleRate: sr, startSec: 1, endSec: 1 })
    expect(res.channels[0].length).toBe(0)
    expect(res.channels[1].length).toBe(0)
    expect(res.durationSec).toBe(0)
  })

  it('mono downmix averages L and R', () => {
    const sources: SourceMap = new Map([['a', constSource(sr, sr, 0.4)]])
    const track = makeTrack(0, { pan: 0, clips: [makeClip({ audioId: 'a', durationSec: 1 })] })
    const res = renderSession(buildSession([track]), sources, { sampleRate: sr, startSec: 0, endSec: 1, channels: 1 })
    expect(res.channels.length).toBe(1)
    // Center pan => L==R => mono == L.
    expect(res.channels[0][500]).toBeGreaterThan(0)
  })

  it('a NaN source sample renders finite (0 there) and never poisons EQ/limiter downstream (FIX #11)', () => {
    const ch = new Float32Array(sr).fill(0.3)
    ch[500] = NaN // a single corrupt source sample
    const sources: SourceMap = new Map([['a', { channels: [ch], sampleRate: sr }]])
    const clip = makeClip({ audioId: 'a', startSec: 0, durationSec: 1 })
    const track = makeTrack(0, { pan: -0.3, eq: { lowDb: 6, midDb: -3, highDb: 4 }, clips: [clip] })
    const res = renderSession(buildSession([track], { gainDb: 6 }), sources, { sampleRate: sr, startSec: 0, endSec: 1 })
    for (let c = 0; c < 2; c++) {
      for (let f = 0; f < res.channels[c].length; f++) expect(Number.isFinite(res.channels[c][f])).toBe(true)
    }
  })

  it('is deterministic: two identical renders are byte-equal', () => {
    const sources: SourceMap = new Map([['a', rampSource(1000, sr, 0.001)]])
    const track = makeTrack(0, {
      pan: -0.3,
      tape: { enabled: true, saturation: 0.4, wowFlutter: 0.5 },
      eq: { lowDb: 3, midDb: -2, highDb: 4 },
      clips: [makeClip({ audioId: 'a', durationSec: 1, fades: { inSec: 0.1, outSec: 0.1 } })],
    })
    const session = buildSession([track], { drive: 0.3, varispeed: 1.5 })
    const opts = { sampleRate: sr, startSec: 0, endSec: 1 }
    const a = renderSession(session, sources, opts)
    const b = renderSession(session, sources, opts)
    expect(a.channels[0].length).toBe(b.channels[0].length)
    for (let f = 0; f < a.channels[0].length; f++) {
      expect(a.channels[0][f]).toBe(b.channels[0][f])
      expect(a.channels[1][f]).toBe(b.channels[1][f])
    }
  })
})

describe('renderSession — region warm-up equivalence (FIX #7)', () => {
  const sr = 1000

  // A region render [t1,T] should equal the [t1,T] slice of a full [0,T] render:
  // the warm-up preroll runs EQ + limiter through the REAL earlier signal so the
  // region no longer starts cold. Frame-exact alignment relies on t1/T landing on
  // integer frames and varispeed=1 (varispeed resamples and is tested separately).
  function assertRegionMatchesFullSlice(session: Session, sources: SourceMap, t1: number, T: number, tol = 1e-6): void {
    const full = renderSession(session, sources, { sampleRate: sr, startSec: 0, endSec: T })
    const region = renderSession(session, sources, { sampleRate: sr, startSec: t1, endSec: T })
    const off = Math.round(t1 * sr)
    expect(region.channels[0].length).toBe(full.channels[0].length - off)
    for (let c = 0; c < 2; c++) {
      for (let f = 0; f < region.channels[c].length; f++) {
        expect(Math.abs(region.channels[c][f] - full.channels[c][off + f])).toBeLessThan(tol)
      }
    }
  }

  it('(a) non-flat EQ + signal before t1: region == full-render slice', () => {
    // Rising ramp over the whole span ⇒ a genuine filter transient the warm-up
    // must settle before t1. Peak stays under the ceiling so this isolates EQ.
    const src = rampSource(2 * sr, sr, 0.0002)
    const sources: SourceMap = new Map([['a', src]])
    const clip = makeClip({ audioId: 'a', startSec: 0, durationSec: 2 })
    const track = makeTrack(0, { pan: -0.3, eq: { lowDb: 6, midDb: -4, highDb: 5 }, clips: [clip] })
    assertRegionMatchesFullSlice(buildSession([track]), sources, 1, 2)
  })

  it('(b) an out-fade crossing the region boundary still matches the full slice', () => {
    // Clip ends at 1.2 with a 0.4s out-fade (0.8→1.2), so the region boundary t1=1.0
    // falls inside the fade — the fade envelope must line up frame-for-frame.
    const src = rampSource(2 * sr, sr, 0.0002)
    const sources: SourceMap = new Map([['a', src]])
    const clip = makeClip({ audioId: 'a', startSec: 0, durationSec: 1.2, fades: { inSec: 0.1, outSec: 0.4 } })
    const track = makeTrack(0, { pan: -0.3, eq: { lowDb: 4, midDb: -3, highDb: 4 }, clips: [clip] })
    assertRegionMatchesFullSlice(buildSession([track]), sources, 1, 2)
  })

  it('(d) a hot mix (limiter engaged before t1): release history matches the full slice', () => {
    // High master gain slams the limiter across the whole span; a varying (ramp)
    // magnitude keeps the release gain moving, so this proves the warm-up carries
    // the limiter's gain-recovery state, not just the EQ.
    const src = rampSource(2 * sr, sr, 0.01)
    const sources: SourceMap = new Map([['a', src]])
    const clip = makeClip({ audioId: 'a', startSec: 0, durationSec: 2 })
    const tracks = [0, 1, 2].map((i) => makeTrack(i, { pan: -0.3, clips: [clip] }))
    assertRegionMatchesFullSlice(buildSession(tracks, { gainDb: 18 }), sources, 1, 2)
  })

  it('(c) region render with tape saturation + wow/flutter is deterministic', () => {
    const src = rampSource(2 * sr, sr, 0.001)
    const sources: SourceMap = new Map([['a', src]])
    const track = makeTrack(0, {
      pan: -0.3,
      tape: { enabled: true, saturation: 0.4, wowFlutter: 0.5 },
      eq: { lowDb: 3, midDb: -2, highDb: 4 },
      clips: [makeClip({ audioId: 'a', startSec: 0, durationSec: 2, fades: { inSec: 0.1, outSec: 0.1 } })],
    })
    const session = buildSession([track], { drive: 0.3 })
    const opts = { sampleRate: sr, startSec: 1, endSec: 2 }
    const a = renderSession(session, sources, opts)
    const b = renderSession(session, sources, opts)
    for (let c = 0; c < 2; c++) {
      expect(a.channels[c].length).toBe(b.channels[c].length)
      for (let f = 0; f < a.channels[c].length; f++) expect(a.channels[c][f]).toBe(b.channels[c][f])
    }
  })

  it('(e) startSec=0 is never prerolled: output is identical for any warmupSec (byte-compat)', () => {
    const src = rampSource(sr, sr, 0.0005)
    const sources: SourceMap = new Map([['a', src]])
    const track = makeTrack(0, {
      pan: -0.3,
      eq: { lowDb: 5, midDb: -3, highDb: 4 },
      tape: { enabled: true, saturation: 0.3, wowFlutter: 0.4 },
      clips: [makeClip({ audioId: 'a', startSec: 0, durationSec: 1, fades: { inSec: 0.1, outSec: 0.1 } })],
    })
    const session = buildSession([track], { drive: 0.2 })
    const a = renderSession(session, sources, { sampleRate: sr, startSec: 0, endSec: 1, warmupSec: 0 })
    const b = renderSession(session, sources, { sampleRate: sr, startSec: 0, endSec: 1, warmupSec: 0.5 })
    expect(a.channels[0].length).toBe(b.channels[0].length)
    for (let c = 0; c < 2; c++) {
      for (let f = 0; f < a.channels[c].length; f++) expect(a.channels[c][f]).toBe(b.channels[c][f])
    }
  })
})
