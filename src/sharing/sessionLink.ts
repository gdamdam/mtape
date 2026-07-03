// mtape — share a session ARRANGEMENT via a URL fragment.
//
// Only the arrangement travels in the link: audio blobs are far too large to
// fit in a URL and stay referenced by `audioId`. A recipient without those
// blobs sees the full arrangement with missing-audio placeholders — expected
// and documented behaviour, not an error.
//
// SECURITY BOUNDARY: a URL fragment is fully attacker-controlled. `decode` must
// NEVER throw and must reject anything oversized (a DoS guard) before parsing;
// success always re-runs sanitizeSession so only a valid model escapes.

import { MAX_SHARE_LINK_BYTES, sanitizeSession, type Session } from '../audio/contracts'

// base64url built on the platform's atob/btoa (present in browsers and modern
// node) plus TextEncoder/TextDecoder, so it is UTF-8 safe and Buffer-free.

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Strict decode: rejects non-alphabet input and malformed lengths by throwing. */
function base64UrlDecode(input: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) throw new Error('invalid base64url alphabet')
  let b64 = input.replace(/-/g, '+').replace(/_/g, '/')
  const remainder = b64.length % 4
  if (remainder === 1) throw new Error('invalid base64url length')
  if (remainder !== 0) b64 += '='.repeat(4 - remainder)
  return base64ToBytes(b64)
}

/**
 * Encode a session into a URL-fragment-safe token: base64url of the sanitized
 * session JSON. Audio remains referenced by id only.
 */
export function encodeSessionLink(session: Session): string {
  const json = JSON.stringify(sanitizeSession(session))
  return base64UrlEncode(new TextEncoder().encode(json))
}

/**
 * Decode a share fragment back into a Session, or null if it is not a valid
 * mtape link. Total (never throws). Rejects: empty, bad base64, non-JSON, or a
 * decoded payload larger than MAX_SHARE_LINK_BYTES. A leading '#' is stripped.
 */
export function decodeSessionLink(fragment: string): Session | null {
  if (typeof fragment !== 'string') return null
  const frag = fragment.startsWith('#') ? fragment.slice(1) : fragment
  if (frag === '') return null

  let bytes: Uint8Array
  try {
    bytes = base64UrlDecode(frag)
  } catch {
    return null
  }
  // Size-check the decoded bytes BEFORE stringifying/parsing so a hostile giant
  // payload is dropped without allocating the parsed object graph.
  if (bytes.length > MAX_SHARE_LINK_BYTES) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
  return sanitizeSession(parsed)
}
