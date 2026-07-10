// mtape — local persistence via raw IndexedDB.
//
// Sessions are small JSON; audio samples are large encoded blobs stored
// separately and keyed by `audioId` so the session JSON only references them.
// No external IndexedDB wrapper is used: the surface we need is small and a
// dependency-free layer keeps the offline bundle lean.
//
// TRUST BOUNDARY: IndexedDB contents can be corrupted, downgraded, or tampered
// with (devtools, older builds). Every session is run through `sanitizeSession`
// on the READ path so the rest of the app only ever sees a valid model.
//
// NOTE: IndexedDB is not implemented in the node test environment, so this file
// is intentionally NOT unit-tested; it is exercised by browser/manual QA. It is
// kept fully typed so the compiler still guards its shape.

import { isFutureSchema, sanitizeSession, SESSION_SCHEMA_VERSION, type Session } from '../audio/contracts'

export const DB_NAME = 'mtape'
export const DB_VERSION = 1
export const SESSIONS_STORE = 'sessions'
export const AUDIO_STORE = 'audio'

/** Lightweight session descriptor for list views — no track/clip payload. */
export interface SessionMeta {
  id: string
  name: string
  updatedAt: number
  trackCount: number
  clipCount: number
}

/** How audio blobs are physically stored (keyPath = `id`). */
interface AudioRecord {
  id: string
  blob: Blob
}

/**
 * Open (and, on first run, create) the mtape database. Rejects with a clear,
 * user-actionable Error in the two ways this realistically fails: the API is
 * absent (SSR / node), or the request is blocked (private-browsing storage
 * policy, or another tab holding an older-version connection open).
 */
export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable in this environment (server-side render or unsupported browser).'))
      return
    }
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (err) {
      // Some engines throw synchronously when storage is disabled entirely.
      reject(new Error(`Could not open IndexedDB: ${err instanceof Error ? err.message : String(err)}`))
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(SESSIONS_STORE)) db.createObjectStore(SESSIONS_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(AUDIO_STORE)) db.createObjectStore(AUDIO_STORE, { keyPath: 'id' })
    }
    // The promise is settled at most once; a `blocked` rejection can still be
    // followed by a late `success` when the blocker tab closes. Track that so the
    // late connection is closed rather than leaked open (and unable to be upgraded).
    let settled = false
    req.onsuccess = () => {
      const db = req.result
      if (settled) {
        db.close()
        return
      }
      settled = true
      // Never let this connection wedge a future upgrade: yield by closing when
      // another tab requests a version change.
      db.onversionchange = () => db.close()
      resolve(db)
    }
    req.onerror = () => {
      if (settled) return
      settled = true
      reject(req.error ?? new Error('Failed to open IndexedDB.'))
    }
    // Fires when an open connection with an older version blocks the upgrade, or
    // when private-mode policy refuses the durable store.
    req.onblocked = () => {
      if (settled) return
      settled = true
      reject(new Error('IndexedDB is blocked — close other mtape tabs, or storage may be disabled (private mode).'))
    }
  })
}

/** Promisify a single request within an already-open transaction. */
function requestAsync<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed.'))
  })
}

/**
 * Run `fn` inside a transaction over `storeNames`. Resolves with `fn`'s value
 * only after the transaction fully COMMITS (`oncomplete`), rejects on
 * error/abort, and always closes the connection afterwards so callers can treat
 * one CRUD call as one self-contained connection.
 */
export async function withTransaction<T>(
  db: IDBDatabase,
  storeNames: string | string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => T | Promise<T>,
): Promise<T> {
  try {
    return await new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction
      try {
        tx = db.transaction(storeNames, mode)
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      // JOIN two conditions before resolving: the transaction must COMMIT
      // (`oncomplete`, so a late write error still rejects) AND `fn` must have
      // produced its value. Resolving on `oncomplete` alone races: if `fn` awaits
      // non-IDB work, the tx auto-commits while `fn` is still pending and we would
      // otherwise resolve `undefined as T`.
      let settled = false
      let committed = false
      let fnDone = false
      let result: T
      const maybeResolve = () => {
        if (committed && fnDone && !settled) {
          settled = true
          resolve(result)
        }
      }
      const fail = (err: unknown) => {
        if (settled) return
        settled = true
        reject(err instanceof Error ? err : new Error(String(err)))
      }
      tx.oncomplete = () => {
        committed = true
        maybeResolve()
      }
      tx.onerror = () => fail(tx.error ?? new Error('IndexedDB transaction failed.'))
      tx.onabort = () => fail(tx.error ?? new Error('IndexedDB transaction aborted.'))
      Promise.resolve(fn(tx))
        .then((r) => {
          result = r
          fnDone = true
          maybeResolve()
        })
        .catch((err) => {
          try {
            tx.abort()
          } catch {
            // Transaction may already be finished; the rejection below is enough.
          }
          fail(err)
        })
    })
  } finally {
    db.close()
  }
}

/** Single-store convenience wrapper over {@link withTransaction}. */
export function withStore<T>(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => T | Promise<T>,
): Promise<T> {
  return withTransaction(db, store, mode, (tx) => fn(tx.objectStore(store)))
}

// --------------------------------------------------------------------------
// Session CRUD
// --------------------------------------------------------------------------

// Optimistic concurrency: the last `updatedAt` THIS module committed (or read)
// per session id. `putSession` stamps a fresh `updatedAt` on every write and
// records it here; the next write refuses to overwrite a row whose stored
// `updatedAt` has advanced beyond what we last saw (another tab wrote in
// between). The timestamp is managed entirely here so `contracts.ts`/`Session`
// need not change. A missing/non-finite stored timestamp is treated as "safe to
// write". This is a concurrent-tab safeguard; assigning fresh ids on import is
// the primary defence against clobbering the newer stored session.
const lastSeenUpdatedAt = new Map<string, number>()

/**
 * Persist a session with an optimistic compare-and-swap guard. Returns `true`
 * if the write was committed, `false` if it was skipped because a newer version
 * of the same session already exists in the store (another tab wrote it).
 */
export async function putSession(session: Session): Promise<boolean> {
  const db = await openDb()
  return withStore(db, SESSIONS_STORE, 'readwrite', async (store) => {
    const existing = (await requestAsync<unknown>(store.get(session.id))) as Partial<Session> | undefined
    const storedAt = typeof existing?.updatedAt === 'number' && Number.isFinite(existing.updatedAt) ? existing.updatedAt : undefined
    const lastSeen = lastSeenUpdatedAt.get(session.id)
    // Refuse the overwrite only when we can prove the stored row is newer than
    // the state we based this write on. Missing stored timestamp, or no prior
    // knowledge of this id, both mean "safe to write".
    if (storedAt !== undefined && lastSeen !== undefined && storedAt > lastSeen) {
      return false
    }
    // Stamp a fresh, monotonic timestamp so a subsequent same-tab write matches
    // and a concurrent tab's stale write is detected.
    const stamped = Math.max(Date.now(), (storedAt ?? 0) + 1, (lastSeen ?? 0) + 1)
    await requestAsync(store.put({ ...session, updatedAt: stamped }))
    lastSeenUpdatedAt.set(session.id, stamped)
    return true
  })
}

export async function getSession(id: string): Promise<Session | null> {
  const db = await openDb()
  const raw = await withStore(db, SESSIONS_STORE, 'readonly', (store) => requestAsync<unknown>(store.get(id)))
  // Read path is a trust boundary: coerce whatever was stored into a valid model.
  if (raw == null) return null
  // A row written by a NEWER build may carry fields this build's sanitizer does
  // not know about; running it through sanitizeSession would silently downgrade
  // it to the current schema (dropping those fields) and — worse — a later
  // putSession could then write that downgraded value back over the newer stored
  // row, an irreversible data loss. Surface it as a recoverable error instead and
  // leave the stored row untouched (this read never writes). getAllSessionMeta
  // stays list-safe: it only reads, so such a row still appears there.
  if (isFutureSchema(raw)) {
    const sv = (raw as { schemaVersion?: unknown }).schemaVersion
    throw new Error(
      `This session was saved by a newer version of mtape (schema v${String(sv)}; this build reads v${SESSION_SCHEMA_VERSION}). ` +
        'Update mtape to open it — the stored session has been left untouched.',
    )
  }
  const session = sanitizeSession(raw)
  // Seed the CAS baseline: a subsequent putSession from this tab should not be
  // treated as a conflict, and a concurrent tab that advances the row while we
  // edit will be detected on our next write.
  if (session.updatedAt > 0) lastSeenUpdatedAt.set(id, session.updatedAt)
  return session
}

export async function getAllSessionMeta(): Promise<SessionMeta[]> {
  const db = await openDb()
  // Fetch values and keys together so a corrupt row's meta id can fall back to
  // its actual store key (keyPath = `id`) instead of the sanitizer's `'session'`
  // placeholder, which would mismatch the key and be unopenable/undeletable.
  const rows = await withStore(db, SESSIONS_STORE, 'readonly', async (store) => {
    const [values, keys] = await Promise.all([
      requestAsync<unknown[]>(store.getAll()),
      requestAsync<IDBValidKey[]>(store.getAllKeys()),
    ])
    return values.map((raw, i) => ({ raw, key: keys[i] }))
  })
  return rows.map(({ raw, key }) => {
    const s = sanitizeSession(raw)
    // The store key is the source of truth for identity; only fall back to the
    // sanitized id if the key is somehow non-string.
    const id = typeof key === 'string' ? key : s.id
    return {
      id,
      name: s.name,
      updatedAt: s.updatedAt,
      trackCount: s.tracks.length,
      clipCount: s.tracks.reduce((n, t) => n + t.clips.length, 0),
    }
  })
}

export async function deleteSession(id: string): Promise<void> {
  const db = await openDb()
  await withStore(db, SESSIONS_STORE, 'readwrite', (store) => requestAsync(store.delete(id)))
}

// --------------------------------------------------------------------------
// Audio blob CRUD — large payloads kept out of the session JSON.
// --------------------------------------------------------------------------

export async function putAudio(id: string, blob: Blob): Promise<void> {
  const db = await openDb()
  const record: AudioRecord = { id, blob }
  await withStore(db, AUDIO_STORE, 'readwrite', (store) => requestAsync(store.put(record)))
}

export async function getAudio(id: string): Promise<Blob | null> {
  const db = await openDb()
  const record = await withStore(db, AUDIO_STORE, 'readonly', (store) => requestAsync<AudioRecord | undefined>(store.get(id)))
  return record?.blob ?? null
}

export async function deleteAudio(id: string): Promise<void> {
  const db = await openDb()
  await withStore(db, AUDIO_STORE, 'readwrite', (store) => requestAsync(store.delete(id)))
}
