import { describe, expect, it, vi } from 'vitest'
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

// UTF-8 byte length of the sanitized session JSON — exactly what encodeSessionLink
// measures against MAX_SHARE_LINK_BYTES.
function jsonByteLength(session: Session): number {
  return new TextEncoder().encode(JSON.stringify(sanitizeSession(session))).length
}

// Build a session whose sanitized-JSON byte length is EXACTLY `target`. Clips
// carry a fixed-length `id` and a variable-length `audioId`, both of which survive
// sanitizeId unchanged (ASCII, <= 64 chars) — so each extra audioId char adds
// exactly one JSON byte, giving byte-precise control for boundary tests.
function sessionOfJsonBytes(target: number): Session {
  const raw = defaultSession('share-me')
  const clips: Session['tracks'][number]['clips'] = []
  raw.tracks[0].clips = clips
  const mk = (i: number, audioLen: number) => ({
    id: 'c' + i,
    audioId: 'a'.repeat(audioLen),
    startSec: 1,
    offsetSec: 0,
    durationSec: 5,
    gainDb: 0,
    fades: { inSec: 0, outSec: 0 },
  })
  // Coarse: add minimal clips until one more would meet/exceed the target.
  while (jsonByteLength(raw) < target) {
    clips.push(mk(clips.length, 1))
    if (jsonByteLength(raw) >= target) {
      clips.pop()
      break
    }
  }
  // Fine: grow audioIds one byte at a time (<= 63 extra chars per clip, so
  // audioId stays within the 64-char cap) to close the remaining gap exactly.
  let gap = target - jsonByteLength(raw)
  for (let i = 0; i < clips.length && gap > 0; i++) {
    const grow = Math.min(63, gap)
    clips[i].audioId = 'a'.repeat(1 + grow)
    gap -= grow
  }
  return raw
}

describe('encode/decode round-trip', () => {
  it('deep-equals sanitizeSession(original)', () => {
    const original = sampleSession()
    const token = encodeSessionLink(original)
    expect(token).not.toBeNull()
    expect(decodeSessionLink(token!)).toEqual(sanitizeSession(original))
  })

  it('strips a leading # from the fragment', () => {
    const token = encodeSessionLink(sampleSession())
    expect(token).not.toBeNull()
    expect(decodeSessionLink('#' + token!)).toEqual(sanitizeSession(sampleSession()))
  })

  it('survives unicode names (UTF-8 safe)', () => {
    const s = sampleSession()
    s.name = 'café — 日本語 🎛️'
    const token = encodeSessionLink(sanitizeSession(s))
    expect(token).not.toBeNull()
    const decoded = decodeSessionLink(token!)
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

  it('rejects a hostile multi-MB fragment on length alone, without decoding (L8)', () => {
    // ~4M base64url chars → floor(N/4)*3 == 3 MB decoded bound, far over the cap.
    const hostile = 'A'.repeat(4_000_000)
    const atobSpy = vi.spyOn(globalThis, 'atob')
    expect(decodeSessionLink(hostile)).toBeNull()
    expect(atobSpy).not.toHaveBeenCalled() // proves no full base64 decode/byte-copy ran
    atobSpy.mockRestore()
  })
})

describe('encode enforces the same size cap as decode (H8)', () => {
  it('encodes a payload exactly at MAX_SHARE_LINK_BYTES and it round-trips', () => {
    const session = sessionOfJsonBytes(MAX_SHARE_LINK_BYTES)
    expect(jsonByteLength(session)).toBe(MAX_SHARE_LINK_BYTES) // fixture really lands on the cap
    const token = encodeSessionLink(session)
    expect(token).not.toBeNull()
    expect(decodeSessionLink(token!)).not.toBeNull()
  })

  it('returns null when the encoded payload exceeds MAX_SHARE_LINK_BYTES', () => {
    const session = sessionOfJsonBytes(MAX_SHARE_LINK_BYTES + 1)
    expect(jsonByteLength(session)).toBe(MAX_SHARE_LINK_BYTES + 1) // one byte over
    expect(encodeSessionLink(session)).toBeNull()
  })
})
