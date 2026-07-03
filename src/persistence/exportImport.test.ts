import { describe, expect, it } from 'vitest'
import { defaultSession, sanitizeSession, SESSION_SCHEMA_VERSION, type Session } from '../audio/contracts'
import { EXPORT_KIND, EXPORT_VERSION, exportSession, parseImport, serializeExport } from './exportImport'

// A representative session with real clip payload so round-trips are meaningful.
function sampleSession(): Session {
  const s = defaultSession('demo-session')
  s.name = 'Demo'
  s.tempo = 128
  s.tracks[0].clips = [
    { id: 'c1', audioId: 'a1', startSec: 1.5, offsetSec: 0.25, durationSec: 4, gainDb: -3, fades: { inSec: 0.5, outSec: 0.5 } },
  ]
  return sanitizeSession(s)
}

describe('exportSession', () => {
  it('wraps a sanitized session in a versioned envelope', () => {
    const exported = exportSession(sampleSession())
    expect(exported.kind).toBe(EXPORT_KIND)
    expect(exported.exportVersion).toBe(EXPORT_VERSION)
    expect(exported.schemaVersion).toBe(SESSION_SCHEMA_VERSION)
    expect(exported.session).toEqual(sanitizeSession(sampleSession()))
  })

  it('is deterministic (no clocks/randomness)', () => {
    expect(serializeExport(exportSession(sampleSession()))).toBe(serializeExport(exportSession(sampleSession())))
  })

  it('preserves clip audio references so a future bundle can rehydrate', () => {
    const exported = exportSession(sampleSession())
    expect(exported.session.tracks[0].clips[0].audioId).toBe('a1')
  })
})

describe('parseImport round-trip', () => {
  it('export -> serialize -> parseImport reproduces the sanitized session', () => {
    const original = sampleSession()
    const restored = parseImport(serializeExport(exportSession(original)))
    expect(restored).toEqual(sanitizeSession(original))
  })
})

describe('parseImport validation', () => {
  it('throws on non-JSON text', () => {
    expect(() => parseImport('not json at all')).toThrow()
  })

  it('throws on a wrong envelope kind', () => {
    const bad = JSON.stringify({ kind: 'something-else', session: {} })
    expect(() => parseImport(bad)).toThrow()
  })

  it('throws on a missing kind', () => {
    expect(() => parseImport(JSON.stringify({ session: {} }))).toThrow()
  })

  it('throws when the envelope has no session', () => {
    // A right-kind, right-version envelope with `session` absent is broken, not
    // coercible — sanitizing `undefined` would silently import an empty arrangement.
    const bad = JSON.stringify({ kind: EXPORT_KIND, exportVersion: EXPORT_VERSION, schemaVersion: SESSION_SCHEMA_VERSION })
    expect(() => parseImport(bad)).toThrow(/no "session"/)
  })

  it('throws when the session is explicitly null', () => {
    const bad = JSON.stringify({ kind: EXPORT_KIND, exportVersion: EXPORT_VERSION, schemaVersion: SESSION_SCHEMA_VERSION, session: null })
    expect(() => parseImport(bad)).toThrow(/no "session"/)
  })

  it('throws on an unsupported exportVersion', () => {
    const future = JSON.stringify({
      kind: EXPORT_KIND,
      exportVersion: EXPORT_VERSION + 1,
      schemaVersion: SESSION_SCHEMA_VERSION,
      session: exportSession(sampleSession()).session,
    })
    expect(() => parseImport(future)).toThrow(/export version/)
  })

  it('throws on an unsupported schemaVersion', () => {
    const future = JSON.stringify({
      kind: EXPORT_KIND,
      exportVersion: EXPORT_VERSION,
      schemaVersion: SESSION_SCHEMA_VERSION + 1,
      session: exportSession(sampleSession()).session,
    })
    expect(() => parseImport(future)).toThrow(/schema version/)
  })

  it('throws on a missing exportVersion (undefined !== supported version)', () => {
    const bad = JSON.stringify({ kind: EXPORT_KIND, schemaVersion: SESSION_SCHEMA_VERSION, session: {} })
    expect(() => parseImport(bad)).toThrow(/export version/)
  })

  it('degrades a garbage inner session to a valid default-ish session (no throw)', () => {
    const envelope = JSON.stringify({ kind: EXPORT_KIND, exportVersion: 1, schemaVersion: 1, session: 42 })
    const restored = parseImport(envelope)
    expect(restored).toEqual(sanitizeSession(42))
    // Sanitizer guarantees the minimum track count even from garbage.
    expect(restored.tracks.length).toBeGreaterThanOrEqual(4)
  })
})
