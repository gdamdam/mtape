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

import { sanitizeSession, type Session } from '../audio/contracts'

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
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB.'))
    // Fires when an open connection with an older version blocks the upgrade, or
    // when private-mode policy refuses the durable store.
    req.onblocked = () => reject(new Error('IndexedDB is blocked — close other mtape tabs, or storage may be disabled (private mode).'))
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
      let result: T
      // Resolve on commit (not on the last request's success) so a late write
      // error still surfaces as a rejection.
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'))
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'))
      Promise.resolve(fn(tx))
        .then((r) => {
          result = r
        })
        .catch((err) => {
          try {
            tx.abort()
          } catch {
            // Transaction may already be finished; the rejection below is enough.
          }
          reject(err instanceof Error ? err : new Error(String(err)))
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

export async function putSession(session: Session): Promise<void> {
  const db = await openDb()
  await withStore(db, SESSIONS_STORE, 'readwrite', (store) => requestAsync(store.put(session)))
}

export async function getSession(id: string): Promise<Session | null> {
  const db = await openDb()
  const raw = await withStore(db, SESSIONS_STORE, 'readonly', (store) => requestAsync<unknown>(store.get(id)))
  // Read path is a trust boundary: coerce whatever was stored into a valid model.
  return raw == null ? null : sanitizeSession(raw)
}

export async function getAllSessionMeta(): Promise<SessionMeta[]> {
  const db = await openDb()
  const rows = await withStore(db, SESSIONS_STORE, 'readonly', (store) => requestAsync<unknown[]>(store.getAll()))
  return rows.map((raw) => {
    const s = sanitizeSession(raw)
    return {
      id: s.id,
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
