import { describe, expect, it } from 'vitest'
import { applyMonitorGains, monitoredTrackIds } from './monitor'

const port = (value = 0) => ({ monitor: { gain: { value } } })

describe('monitoredTrackIds', () => {
  it('collects only tracks with monitor on', () => {
    const ids = monitoredTrackIds([
      { trackId: 'a', monitor: true },
      { trackId: 'b', monitor: false },
      { trackId: 'c', monitor: true },
    ])
    expect([...ids].sort()).toEqual(['a', 'c'])
  })
})

describe('applyMonitorGains', () => {
  it('opens the gain for monitored attached inputs and closes the rest', () => {
    const a = port()
    const b = port(1) // was monitored, MON since toggled off
    const inputs = new Map([
      ['a', a],
      ['b', b],
    ])
    applyMonitorGains(inputs, new Set(['a']))
    expect(a.monitor.gain.value).toBe(1)
    expect(b.monitor.gain.value).toBe(0)
  })

  it('closes the gain for inputs whose track is not in the arrangement at all', () => {
    const orphan = port(1)
    applyMonitorGains(new Map([['gone', orphan]]), new Set())
    expect(orphan.monitor.gain.value).toBe(0)
  })
})
