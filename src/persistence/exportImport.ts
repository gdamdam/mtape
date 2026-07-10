// mtape — portable session export/import as a pure JSON envelope.
//
// This serializes the ARRANGEMENT only (structure + audio references). The audio
// blobs themselves are NOT included: a self-contained bundle (session JSON +
// audio) is a documented future extension, likely a zip. Because clips keep
// their `audioId`, such a bundle importer could rehydrate blobs later; a plain
// JSON import restores the arrangement with audio shown as missing placeholders.

import { MAX_IMPORT_BYTES, SESSION_SCHEMA_VERSION, sanitizeSession, type Session } from '../audio/contracts'

export const EXPORT_KIND = 'mtape-session'
export const EXPORT_VERSION = 1

/** The on-disk envelope wrapping a session with format metadata. */
export interface SessionExport {
  kind: typeof EXPORT_KIND
  exportVersion: number
  schemaVersion: number
  session: Session
}

/**
 * Wrap a session for export. Deterministic and clock-free (no timestamps or
 * ids invented here); the session is re-sanitized so an export is always valid.
 */
export function exportSession(session: Session): SessionExport {
  return {
    kind: EXPORT_KIND,
    exportVersion: EXPORT_VERSION,
    schemaVersion: SESSION_SCHEMA_VERSION,
    session: sanitizeSession(session),
  }
}

/** Pretty-printed for human-diffable, VCS-friendly export files. */
export function serializeExport(exported: SessionExport): string {
  return JSON.stringify(exported, null, 2)
}

/**
 * Parse and validate an exported file back into a Session. Throws a clear Error
 * for a wrong/missing envelope kind, non-JSON text, an unsupported version, or a
 * missing `session` — those all signal "this file cannot be trusted to restore".
 * A well-formed, version-matched envelope whose inner session is merely malformed
 * degrades gracefully via sanitizeSession rather than throwing.
 */
export function parseImport(text: string): Session {
  // DoS guard: reject a pathologically large document BEFORE JSON.parse builds
  // its object graph. `text.length` (UTF-16 code units) is a conservative lower
  // bound on the UTF-8 byte length, so anything over MAX_IMPORT_BYTES is
  // genuinely oversized while a real session (well under the cap) is untouched.
  // Same failure contract as the checks below: throw, never silently coerce.
  if (typeof text !== 'string' || text.length > MAX_IMPORT_BYTES) {
    throw new Error(`Not a valid mtape session file: input is too large (limit ${MAX_IMPORT_BYTES} bytes).`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Not a valid mtape session file: contents are not JSON.')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Not a valid mtape session file: expected an envelope object.')
  }
  const envelope = parsed as Partial<SessionExport>
  if (envelope.kind !== EXPORT_KIND) {
    throw new Error(`Not an mtape session file (expected kind "${EXPORT_KIND}", got "${String(envelope.kind)}").`)
  }
  // A missing inner session is a broken/incomplete envelope, not a coercible one:
  // sanitizing `undefined` into a near-empty default would silently import an
  // empty arrangement (and autosave could then persist it — see H9).
  if (envelope.session == null) {
    throw new Error('Not a valid mtape session file: envelope has no "session".')
  }
  // Refuse envelopes from a newer/renamed format — the declared shape may differ
  // from what our sanitizer expects, so importing would silently drop data.
  if (envelope.exportVersion !== EXPORT_VERSION) {
    throw new Error(
      `Unsupported mtape export version ${String(envelope.exportVersion)} (this build reads version ${EXPORT_VERSION}).`,
    )
  }
  if (envelope.schemaVersion !== SESSION_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported mtape session schema version ${String(envelope.schemaVersion)} (this build reads version ${SESSION_SCHEMA_VERSION}).`,
    )
  }
  // Inner session is untrusted — coerce rather than trust the declared shape.
  return sanitizeSession(envelope.session)
}
