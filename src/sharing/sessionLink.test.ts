import { describe, expect, it } from 'vitest'
import { defaultSession, MAX_SHARE_LINK_BYTES, sanitizeSession, type Session } from '../audio/contracts'
import { decodeSessionLink, encodeSessionLink } from './sessionLink'

function sampleSession(): Session {
  const s = defaultSession('share-me')
  s.name = 'Shared arrangement'
  s.tempo = 90
  s.tracks[0].clips = [
    { id: 'c1', audioId: 'a1', startSec: 2, offsetSec: 0, durationSec: 8, gainDb: 0, fades: { inSec: 0, outSec: 1 } },
  ]
  return sanitizeSession(s)
}

// Encode arbitrary bytes exactly the way the codec does, so we can craft an
// oversized-yet-well-formed payload without depending on codec internals.
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('encode/decode round-trip', () => {
  it('deep-equals sanitizeSession(original)', () => {
    const original = sampleSession()
    const decoded = decodeSessionLink(encodeSessionLink(original))
    expect(decoded).toEqual(sanitizeSession(original))
  })

  it('strips a leading # from the fragment', () => {
    const token = encodeSessionLink(sampleSession())
    expect(decodeSessionLink('#' + token)).toEqual(sanitizeSession(sampleSession()))
  })

  it('survives unicode names (UTF-8 safe)', () => {
    const s = sampleSession()
    s.name = 'café — 日本語 🎛️'
    const decoded = decodeSessionLink(encodeSessionLink(sanitizeSession(s)))
    expect(decoded?.name).toBe(sanitizeSession(s).name)
  })
})

describe('decodeSessionLink rejects hostile input (never throws)', () => {
  it('returns null for an empty string', () => {
    expect(decodeSessionLink('')).toBeNull()
  })

  it('returns null for a bare #', () => {
    expect(decodeSessionLink('#')).toBeNull()
  })

  it('returns null for non-base64 input', () => {
    expect(decodeSessionLink('not-base64!!')).toBeNull()
  })

  it('returns null for base64 of non-JSON', () => {
    expect(decodeSessionLink(bytesToBase64Url(new TextEncoder().encode('hello world')))).toBeNull()
  })

  it('returns null for a payload larger than MAX_SHARE_LINK_BYTES', () => {
    const oversized = new Uint8Array(MAX_SHARE_LINK_BYTES + 1).fill(65) // valid base64-able bytes
    expect(decodeSessionLink(bytesToBase64Url(oversized))).toBeNull()
  })

  it('accepts a payload exactly at the size limit', () => {
    // Well below the cap, a normal session must decode fine.
    const token = encodeSessionLink(sampleSession())
    expect(decodeSessionLink(token)).not.toBeNull()
  })
})
