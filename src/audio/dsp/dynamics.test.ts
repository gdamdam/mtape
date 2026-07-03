import { describe, expect, it } from 'vitest'
import { LIMITER_CEILING_DB_DEFAULT } from '../contracts'
import { BrickwallLimiter, ceilingLin, softClipDrive } from './dynamics'

const SR = 48000

describe('softClipDrive', () => {
  it('amount 0 is exact identity on [-1, 1]', () => {
    for (let x = -1; x <= 1.0001; x += 0.1) {
      expect(softClipDrive(x, 0)).toBe(x)
    }
  })

  it('is odd-symmetric: f(-x) === -f(x)', () => {
    for (const amount of [0.2, 0.5, 1]) {
      for (const x of [0.1, 0.37, 0.8, 1, 3]) {
        expect(softClipDrive(-x, amount)).toBeCloseTo(-softClipDrive(x, amount), 12)
      }
    }
  })

  it('is monotonic increasing in x for any drive amount', () => {
    for (const amount of [0.1, 0.5, 1]) {
      let prev = -Infinity
      for (let x = -2; x <= 2; x += 0.05) {
        const y = softClipDrive(x, amount)
        expect(y).toBeGreaterThan(prev)
        prev = y
      }
    }
  })

  it('is bounded: keeps [-1, 1] inputs within [-1, 1]', () => {
    for (const amount of [0.1, 0.5, 1]) {
      for (let x = -1; x <= 1.0001; x += 0.05) {
        expect(Math.abs(softClipDrive(x, amount))).toBeLessThanOrEqual(1 + 1e-9)
      }
    }
  })

  it('is bounded for large inputs (tanh saturation)', () => {
    for (const amount of [0.25, 1]) {
      const y = softClipDrive(1e6, amount)
      expect(Number.isFinite(y)).toBe(true)
    }
  })

  it('adds drive: more amount lifts mid-level signals relative to peaks', () => {
    // A soft clipper pulls sub-peak levels up as it hardens; 0.5 maps higher.
    const low = softClipDrive(0.5, 0.2)
    const high = softClipDrive(0.5, 0.9)
    expect(high).toBeGreaterThan(low)
  })
})

describe('ceilingLin', () => {
  it('0 dBFS is unity', () => {
    expect(ceilingLin(0)).toBeCloseTo(1, 12)
  })

  it('-6 dBFS ≈ 0.501', () => {
    expect(ceilingLin(-6)).toBeCloseTo(0.501, 3)
  })
})

describe('BrickwallLimiter', () => {
  const EPS = 1e-6

  it('output never exceeds the ceiling for a loud sine', () => {
    const ceilingDb = -0.3
    const ceil = ceilingLin(ceilingDb)
    const lim = new BrickwallLimiter({ ceilingDb, sampleRate: SR })
    // A sine well over the ceiling (peak 4.0).
    const input = new Float32Array(4000)
    for (let i = 0; i < input.length; i++) input[i] = 4 * Math.sin((2 * Math.PI * 440 * i) / SR)
    const out = lim.processBlock(input)
    for (const y of out) expect(Math.abs(y)).toBeLessThanOrEqual(ceil + EPS)
  })

  it('output never exceeds the ceiling on a step/transient (from sample 0)', () => {
    const ceilingDb = -6
    const ceil = ceilingLin(ceilingDb)
    const lim = new BrickwallLimiter({ ceilingDb, sampleRate: SR })
    // A silent lead-in then a hard step to a large value.
    const input = new Float32Array(1000)
    for (let i = 0; i < input.length; i++) input[i] = i < 100 ? 0 : 9
    const out = lim.processBlock(input)
    for (const y of out) expect(Math.abs(y)).toBeLessThanOrEqual(ceil + EPS)
    // Even the very first over-ceiling sample is caught (instant attack).
    expect(Math.abs(out[100])).toBeLessThanOrEqual(ceil + EPS)
  })

  it('is transparent (exact unity) for signals below the ceiling', () => {
    const lim = new BrickwallLimiter({ ceilingDb: 0, sampleRate: SR })
    const input = new Float32Array(500)
    for (let i = 0; i < input.length; i++) input[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)
    const out = lim.processBlock(input)
    out.forEach((y, i) => expect(y).toBeCloseTo(input[i], 6))
  })

  it('setCeiling tightens the limit', () => {
    const lim = new BrickwallLimiter({ ceilingDb: 0, sampleRate: SR, releaseMs: 1 })
    lim.setCeiling(-12)
    const ceil = ceilingLin(-12)
    const input = new Float32Array(2000).fill(1)
    const out = lim.processBlock(input)
    for (const y of out) expect(Math.abs(y)).toBeLessThanOrEqual(ceil + 1e-6)
  })

  it('reset restores unity gain', () => {
    const lim = new BrickwallLimiter({ ceilingDb: LIMITER_CEILING_DB_DEFAULT, sampleRate: SR })
    lim.processBlock(new Float32Array(500).fill(5)) // drive gain reduction down
    lim.reset()
    // After reset a below-ceiling sample passes at unity again.
    expect(lim.process(0.1)).toBeCloseTo(0.1, 9)
  })
})
