import { describe, expect, it } from 'vitest'
import type { ThreeBandEq } from '../contracts'
import {
  Biquad,
  ThreeBandEqProcessor,
  highShelf,
  lowShelf,
  magnitudeAt,
  peaking,
  type BiquadCoeffs,
} from './eq'

const SR = 48000

// A flat (0 dB) EQ, reused across the identity assertions.
const FLAT: ThreeBandEq = { lowDb: 0, midDb: 0, highDb: 0 }

// Sweep of probe frequencies spanning sub-bass to near-Nyquist.
const PROBES = [20, 60, 120, 300, 1000, 4000, 10000, 20000]

/** Run a signal through a fresh processor and return the output samples. */
function runEq(eq: ThreeBandEq, input: number[]): number[] {
  const p = new ThreeBandEqProcessor(eq, SR)
  return input.map((x) => p.process(x))
}

describe('flat EQ (all bands 0 dB)', () => {
  it('has unity magnitude across the spectrum for every band type', () => {
    const bands: BiquadCoeffs[] = [lowShelf(120, 0, SR), peaking(1000, 0, SR), highShelf(4000, 0, SR)]
    for (const c of bands) {
      for (const f of PROBES) {
        expect(magnitudeAt(c, f, SR)).toBeCloseTo(1, 6)
      }
    }
  })

  it('passes signal through unchanged (process(x) ≈ x)', () => {
    const input = [1, 0.5, -0.3, 0.9, -0.7, 0.2, 0, -1]
    const out = runEq(FLAT, input)
    out.forEach((y, i) => expect(y).toBeCloseTo(input[i], 9))
  })
})

describe('low-shelf', () => {
  it('+6 dB boosts DC/low frequencies by ~2x, leaving highs ~unity', () => {
    const c = lowShelf(120, 6, SR)
    // DC gain of a low-shelf is A² == 10^(dB/20) ≈ 1.995 for +6 dB.
    expect(magnitudeAt(c, 1, SR)).toBeCloseTo(1.995, 1)
    expect(magnitudeAt(c, 20, SR)).toBeGreaterThan(1.8)
    // Well above the corner the shelf is flat.
    expect(magnitudeAt(c, 20000, SR)).toBeCloseTo(1, 1)
  })

  it('-6 dB cuts lows below unity', () => {
    const c = lowShelf(120, -6, SR)
    expect(magnitudeAt(c, 20, SR)).toBeLessThan(0.6)
    expect(magnitudeAt(c, 20000, SR)).toBeCloseTo(1, 1)
  })
})

describe('high-shelf', () => {
  it('+6 dB boosts high frequencies by ~2x, leaving lows ~unity', () => {
    const c = highShelf(4000, 6, SR)
    expect(magnitudeAt(c, 1, SR)).toBeCloseTo(1, 1)
    expect(magnitudeAt(c, 20000, SR)).toBeGreaterThan(1.8)
  })
})

describe('peaking', () => {
  it('+6 dB boosts near the centre, ~unity far away', () => {
    const c = peaking(1000, 6, SR)
    // Bell peak gain at centre is A² ≈ 1.995 for +6 dB.
    expect(magnitudeAt(c, 1000, SR)).toBeCloseTo(1.995, 1)
    expect(magnitudeAt(c, 20, SR)).toBeCloseTo(1, 1)
    expect(magnitudeAt(c, 20000, SR)).toBeCloseTo(1, 1)
  })

  it('-6 dB cuts at the centre', () => {
    const c = peaking(1000, -6, SR)
    expect(magnitudeAt(c, 1000, SR)).toBeLessThan(0.6)
  })
})

describe('Biquad instance', () => {
  it('flat coefficients give an impulse response ≈ impulse in (identity)', () => {
    const b = new Biquad(peaking(1000, 0, SR))
    const impulseIn = [1, 0, 0, 0, 0, 0]
    const out = impulseIn.map((x) => b.process(x))
    expect(out[0]).toBeCloseTo(1, 9)
    out.slice(1).forEach((y) => expect(y).toBeCloseTo(0, 9))
  })

  it('reset clears delay memory (repeats identically)', () => {
    const b = new Biquad(lowShelf(120, 6, SR))
    const drive = [1, 0.5, -0.4, 0.8]
    const first = drive.map((x) => b.process(x))
    b.reset()
    const second = drive.map((x) => b.process(x))
    first.forEach((y, i) => expect(second[i]).toBeCloseTo(y, 12))
  })
})

describe('ThreeBandEqProcessor', () => {
  it('a low-shelf boost raises the energy of a low-frequency signal', () => {
    // 60 Hz sine, one cycle sampled coarsely — compare summed |amplitude|.
    const n = 800
    const sig = Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 60 * i) / SR))
    const flat = runEq(FLAT, sig)
    const boosted = runEq({ lowDb: 12, midDb: 0, highDb: 0 }, sig)
    const energy = (xs: number[]) => xs.reduce((s, x) => s + x * x, 0)
    expect(energy(boosted)).toBeGreaterThan(energy(flat) * 2)
  })

  it('reset returns the processor to its initial state', () => {
    const p = new ThreeBandEqProcessor({ lowDb: 6, midDb: -3, highDb: 4 }, SR)
    const drive = [1, 0.5, -0.4, 0.8, -0.2]
    const first = drive.map((x) => p.process(x))
    p.reset()
    const second = drive.map((x) => p.process(x))
    first.forEach((y, i) => expect(second[i]).toBeCloseTo(y, 12))
  })

  it('setParams changes the response', () => {
    const p = new ThreeBandEqProcessor(FLAT, SR)
    const dc = () => {
      p.reset()
      // Feed a long DC ramp so the filter settles, then read steady-state.
      let y = 0
      for (let i = 0; i < 2000; i++) y = p.process(1)
      return y
    }
    const flatDc = dc()
    p.setParams({ lowDb: 12, midDb: 0, highDb: 0 })
    const boostedDc = dc()
    expect(boostedDc).toBeGreaterThan(flatDc * 2)
  })
})
