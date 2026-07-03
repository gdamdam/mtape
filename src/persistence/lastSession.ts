// mtape — localStorage autosave of the working-session pointer + UI prefs.
//
// This is a convenience cache, never a source of truth: the sessions themselves
// live in IndexedDB. Storage can be full, disabled, or hold stale/garbage
// values, so EVERY function here is total — it swallows storage errors and
// validates on read. A failed autosave must never break the app.

const LAST_SESSION_KEY = 'mtape.lastSessionId'
const PREFS_KEY = 'mtape.prefs'

/** Small, user-facing view preferences persisted across reloads. */
export interface Prefs {
  snapToBar: boolean
  showTimeRuler: boolean
}

const DEFAULT_PREFS: Prefs = { snapToBar: true, showTimeRuler: true }

/** Access localStorage only if it exists and is usable; never throw. */
function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    // Accessing localStorage can itself throw when cookies/storage are blocked.
    return null
  }
}

/** Coerce any parsed value into a fully valid Prefs, defaulting each field. */
export function sanitizePrefs(value: unknown): Prefs {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_PREFS }
  const v = value as Partial<Record<keyof Prefs, unknown>>
  return {
    snapToBar: typeof v.snapToBar === 'boolean' ? v.snapToBar : DEFAULT_PREFS.snapToBar,
    showTimeRuler: typeof v.showTimeRuler === 'boolean' ? v.showTimeRuler : DEFAULT_PREFS.showTimeRuler,
  }
}

export function saveLastSessionId(id: string): void {
  const s = storage()
  if (!s || typeof id !== 'string' || id === '') return
  try {
    s.setItem(LAST_SESSION_KEY, id)
  } catch {
    // Quota exceeded or storage disabled mid-session — nothing to do.
  }
}

export function loadLastSessionId(): string | null {
  const s = storage()
  if (!s) return null
  try {
    const raw = s.getItem(LAST_SESSION_KEY)
    return typeof raw === 'string' && raw.length > 0 ? raw : null
  } catch {
    return null
  }
}

export function savePrefs(prefs: Prefs): void {
  const s = storage()
  if (!s) return
  try {
    // Persist a sanitized copy so a caller can't write out-of-shape prefs.
    s.setItem(PREFS_KEY, JSON.stringify(sanitizePrefs(prefs)))
  } catch {
    // Ignore serialization/quota failures.
  }
}

export function loadPrefs(): Prefs {
  const s = storage()
  if (!s) return { ...DEFAULT_PREFS }
  try {
    const raw = s.getItem(PREFS_KEY)
    if (raw == null) return { ...DEFAULT_PREFS }
    return sanitizePrefs(JSON.parse(raw) as unknown)
  } catch {
    // Malformed JSON or read failure → safe defaults.
    return { ...DEFAULT_PREFS }
  }
}
