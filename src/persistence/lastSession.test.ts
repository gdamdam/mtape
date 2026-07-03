import { afterEach, describe, expect, it } from 'vitest'
import { loadLastSessionId, loadPrefs, sanitizePrefs, savePrefs, saveLastSessionId, type Prefs } from './lastSession'

// Minimal in-memory Storage stand-in so we can exercise the read/write paths in
// the node test env (which has no localStorage). Assigning to globalThis lets
// the module's lazy `storage()` accessor pick it up.
function installStorage(): Map<string, string> {
  const map = new Map<string, string>()
  const mock: Storage = {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i) => Array.from(map.keys())[i] ?? null,
    removeItem: (k) => {
      map.delete(k)
    },
    setItem: (k, v) => {
      map.set(k, String(v))
    },
  }
  ;(globalThis as { localStorage?: Storage }).localStorage = mock
  return map
}

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage
})

describe('sanitizePrefs', () => {
  it('defaults on non-object garbage', () => {
    expect(sanitizePrefs(null)).toEqual({ snapToBar: true, showTimeRuler: true })
    expect(sanitizePrefs('nope')).toEqual({ snapToBar: true, showTimeRuler: true })
    expect(sanitizePrefs(undefined)).toEqual({ snapToBar: true, showTimeRuler: true })
  })

  it('coerces non-boolean fields to their defaults', () => {
    expect(sanitizePrefs({ snapToBar: 'yes', showTimeRuler: 0 })).toEqual({ snapToBar: true, showTimeRuler: true })
  })

  it('preserves valid boolean fields', () => {
    const prefs: Prefs = { snapToBar: false, showTimeRuler: false }
    expect(sanitizePrefs(prefs)).toEqual(prefs)
  })

  it('fills only the missing field', () => {
    expect(sanitizePrefs({ snapToBar: false })).toEqual({ snapToBar: false, showTimeRuler: true })
  })
})

describe('without a storage backend (node default)', () => {
  it('reads return safe defaults and writes are no-ops (never throw)', () => {
    expect(loadLastSessionId()).toBeNull()
    expect(loadPrefs()).toEqual({ snapToBar: true, showTimeRuler: true })
    expect(() => saveLastSessionId('x')).not.toThrow()
    expect(() => savePrefs({ snapToBar: false, showTimeRuler: false })).not.toThrow()
  })
})

describe('with a storage backend', () => {
  it('round-trips the last session id', () => {
    installStorage()
    saveLastSessionId('session-42')
    expect(loadLastSessionId()).toBe('session-42')
  })

  it('ignores empty session ids', () => {
    installStorage()
    saveLastSessionId('')
    expect(loadLastSessionId()).toBeNull()
  })

  it('round-trips prefs and re-sanitizes on read', () => {
    const map = installStorage()
    savePrefs({ snapToBar: false, showTimeRuler: true })
    expect(loadPrefs()).toEqual({ snapToBar: false, showTimeRuler: true })
    // Corrupt the stored value: loadPrefs must fall back, not throw.
    map.set('mtape.prefs', '{not valid json')
    expect(loadPrefs()).toEqual({ snapToBar: true, showTimeRuler: true })
  })
})
