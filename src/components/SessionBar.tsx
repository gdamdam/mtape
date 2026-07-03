// mtape — session management strip: new/save, the editable session name, an
// open-session picker (from IndexedDB), JSON export/import, and the share link.

import { useRef, useState, type Dispatch, type ReactNode } from 'react'
import type { Action, AppState } from '../app/state'
import type { UiControls } from '../app/useEngine'
import { getAllSessionMeta, type SessionMeta } from '../persistence/db'

interface SessionBarProps {
  state: AppState
  controls: UiControls
  dispatch: Dispatch<Action>
}

export function SessionBar({ state, controls, dispatch }: SessionBarProps): ReactNode {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null)
  const importRef = useRef<HTMLInputElement | null>(null)

  const toggleOpen = async (): Promise<void> => {
    if (sessions) {
      setSessions(null)
      return
    }
    try {
      setSessions(await getAllSessionMeta())
    } catch {
      setSessions([])
    }
  }

  return (
    <section className="session-bar panel" aria-label="Session">
      <button type="button" onClick={() => controls.newSession()}>
        New
      </button>
      <button type="button" onClick={() => void controls.saveSession()}>
        Save
      </button>

      <input
        className="session-bar__name"
        aria-label="Session name"
        value={state.session.name}
        onChange={(e) => dispatch({ type: 'RENAME_SESSION', name: e.currentTarget.value })}
      />

      <div className="session-bar__open">
        <button type="button" aria-expanded={sessions !== null} onClick={() => void toggleOpen()}>
          Open…
        </button>
        {sessions !== null ? (
          <ul className="session-bar__list panel" role="listbox" aria-label="Saved sessions">
            {sessions.length === 0 ? (
              <li className="session-bar__empty">No saved sessions</li>
            ) : (
              sessions.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className="session-bar__item"
                    onClick={() => {
                      void controls.loadSession(m.id)
                      setSessions(null)
                    }}
                  >
                    <span>{m.name}</span>
                    <span className="label">{m.trackCount}tr · {m.clipCount}clip</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        ) : null}
      </div>

      <button type="button" onClick={() => controls.exportJson()}>
        Export JSON
      </button>
      <button type="button" onClick={() => importRef.current?.click()}>
        Import JSON
      </button>
      <input
        ref={importRef}
        className="sr-only"
        type="file"
        accept="application/json,.json"
        onChange={(e) => {
          const file = e.currentTarget.files?.[0]
          if (file) void controls.importJson(file)
          e.currentTarget.value = ''
        }}
      />
      <button type="button" onClick={() => void controls.copyShareLink()}>
        Copy share link
      </button>
    </section>
  )
}
