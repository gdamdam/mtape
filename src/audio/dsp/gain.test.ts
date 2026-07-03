import { describe, expect, it } from 'vitest'
import { GAIN_DB_MAX, GAIN_DB_MIN } from '../contracts'
import { dbToLin, linToDb, panGains, SILENCE_DB, trackGainLin } from './gain'

describe('dbToLin', () => {
  it('unity gain at 0 dB', () => {
    expect(dbToLin(0)).toBeCloseTo(1, 12)
  })

  it('-6 dB is roughly half amplitude', () => {
    expect(dbToLin(-6)).toBeCloseTo(0.501, 3)
  })

  it('collapses to exact zero at and below the mute floor', () => {
    expect(dbToLin(SILENCE_DB)).toBe(0)
    expect(dbToLin(-120)).toBe(0)
  })

  it('is monotonic across the audible range', () => {
    let prev = -Infinity
    for (let db = -59; db <= 12; db += 1) {
      const lin = dbToLin(db)
      expect(lin).toBeGreaterThan(prev)
      prev = lin
    }
  })
})

describe('linToDb', () => {
  it('round-trips dbToLin within tolerance', () => {
    for (const db of [-59, -40, -18, -6, -3, 0, 6, 12]) {
      expect(linToDb(dbToLin(db))).toBeCloseTo(db, 6)
    }
  })

  it('unity amplitude is 0 dB', () => {
    expect(linToDb(1)).toBeCloseTo(0, 12)
  })

  it('clamps non-positive input to the mute floor', () => {
    expect(linToDb(0)).toBe(SILENCE_DB)
    expect(linToDb(-1)).toBe(SILENCE_DB)
  })

  it('clamps sub-floor amplitudes to the mute floor', () => {
    // ~ -80 dB is below the floor and must not leak through.
    expect(linToDb(0.0001)).toBe(SILENCE_DB)
  })
})

describe('panGains', () => {
  const EPS = 1e-9

  it('center is equal power on both channels', () => {
    const { left, right } = panGains(0)
    expect(left).toBeCloseTo(Math.SQRT1_2, 6) // ≈ 0.70711
    expect(right).toBeCloseTo(Math.SQRT1_2, 6)
  })

  it('hard left', () => {
    const { left, right } = panGains(-1)
    expect(left).toBeCloseTo(1, 12)
    expect(right).toBeCloseTo(0, 12)
  })

  it('hard right', () => {
    const { left, right } = panGains(1)
    expect(left).toBeCloseTo(0, 12)
    expect(right).toBeCloseTo(1, 12)
  })

  it('holds constant power (left² + right² == 1) across the sweep', () => {
    for (let pan = -1; pan <= 1 + EPS; pan += 0.05) {
      const { left, right } = panGains(pan)
      expect(left * left + right * right).toBeCloseTo(1, 10)
    }
  })

  it('clamps out-of-range pan to the endpoints', () => {
    expect(panGains(-4)).toEqual(panGains(-1))
    expect(panGains(4)).toEqual(panGains(1))
  })
})

describe('trackGainLin', () => {
  it('unity at 0 dB', () => {
    expect(trackGainLin(0)).toBeCloseTo(1, 12)
  })

  it('clamps above the max dB before converting', () => {
    expect(trackGainLin(100)).toBeCloseTo(dbToLin(GAIN_DB_MAX), 12)
  })

  it('clamps below the min dB (mute floor) before converting', () => {
    // GAIN_DB_MIN coincides with the silence floor, so this is exact zero.
    expect(trackGainLin(-999)).toBe(dbToLin(GAIN_DB_MIN))
    expect(trackGainLin(-999)).toBe(0)
  })
})
