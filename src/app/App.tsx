// mtape — single-screen composition. Owns the reducer, mirrors state into a ref
// for the engine bridge + hot-path readouts, gates all audio behind an explicit
// "Start audio" gesture (browser autoplay policy), and wires Space to play/stop
// unless the user is typing in a field.

import { useEffect, useReducer, useRef, type ReactNode } from 'react'
import { initialState, reducer } from './state'
import { useEngine } from './useEngine'
import { defaultSession, DRIVE_MAX, DRIVE_MIN, GAIN_DB_MAX, GAIN_DB_MIN, TRACK_COUNT_MAX, TRACK_COUNT_MIN } from '../audio/contracts'
import { TransportBar } from '../components/TransportBar'
import { MasterSection } from '../components/MasterSection'
import { TrackStrip } from '../components/TrackStrip'
import { Timeline } from '../components/Timeline'
import { SessionBar } from '../components/SessionBar'
import { formatDb, formatPct } from '../components/uiHelpers'

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** True when focus is in a text control, where Space must type a space. */
function isTypingTarget(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export function App(): ReactNode {
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState(defaultSession(newId())))
  // Refresh the ref during render so the engine bridge + event handlers read the
  // latest state without re-subscribing.
  const stateRef = useRef(state)
  stateRef.current = state

  const { controls, posRef, meterRef, mbusSources, mbusChoices, sourceDurationSec } = useEngine(dispatch, stateRef)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || e.repeat) return
      const el = document.activeElement
      // Don't hijack Space while a control is focused — Space must activate the
      // focused button (incl. the "Start audio" gate) or type into a field.
      // Only steal it when focus rests on the body/timeline.
      if (isTypingTarget(el)) return
      if (el instanceof HTMLElement && el.tagName === 'BUTTON') return
      e.preventDefault()
      if (!stateRef.current.audioReady) return
      if (stateRef.current.playing) controls.stop()
      else controls.play()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [controls])

  const canRemove = state.session.tracks.length > TRACK_COUNT_MIN
  const canAdd = state.session.tracks.length < TRACK_COUNT_MAX

  return (
    <div className="app">
      {/* While the audio gate is up the app must not be interactable behind it
          (the gate is aria-modal but that alone doesn't block tab/click). inert
          on a display:contents wrapper neutralises the content without altering
          the flex layout, and leaves the gate itself live. */}
      <div style={{ display: 'contents' }} inert={!state.audioReady}>
      <header className="app__header panel">
        <div className="app__brand">
          <img className="app__wordmark" src="/wordmark.svg" alt="mtape" width={120} height={40} />
          <span className="readout app__version">v{__APP_VERSION__}</span>
        </div>
        <div className="app__master" aria-label="Master output">
          <label className="app__master-ctl">
            <span className="label">Vol</span>
            <input
              type="range"
              min={GAIN_DB_MIN}
              max={GAIN_DB_MAX}
              step={0.1}
              value={state.session.master.gainDb}
              onChange={(e) => dispatch({ type: 'SET_MASTER', patch: { gainDb: Number(e.currentTarget.value) } })}
            />
            <span className="readout app__master-val">{formatDb(state.session.master.gainDb)}</span>
          </label>
          <label className="app__master-ctl">
            <span className="label">Gain</span>
            <input
              type="range"
              min={DRIVE_MIN}
              max={DRIVE_MAX}
              step={0.01}
              value={state.session.master.drive}
              onChange={(e) => dispatch({ type: 'SET_MASTER', patch: { drive: Number(e.currentTarget.value) } })}
            />
            <span className="readout app__master-val">{formatPct(state.session.master.drive)}</span>
          </label>
        </div>
        <p className="app__hook">Press record on your browser. Arrange what you played. Bounce a song.</p>
      </header>

      {state.status ? (
        <div className="app__status readout" role="status">
          <span>{state.status}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dispatch({ type: 'SET_STATUS', status: null })}>
            ×
          </button>
        </div>
      ) : null}

      <TransportBar state={state} controls={controls} dispatch={dispatch} posRef={posRef} />

      <Timeline state={state} controls={controls} dispatch={dispatch} posRef={posRef} sourceDurationSec={sourceDurationSec} />

      <div className="app__console">
        <div className="mixer" aria-label="Mixer">
          <div className="mixer__strips">
            {state.session.tracks.map((track, i) => (
              <TrackStrip key={track.id} track={track} index={i} selected={state.selectedTrackId === track.id} canRemove={canRemove} controls={controls} dispatch={dispatch} meterRef={meterRef} mbusSources={mbusSources} mbusSourceId={mbusChoices[track.id] ?? ''} />
            ))}
          </div>
          <button type="button" className="mixer__add" disabled={!canAdd} onClick={() => dispatch({ type: 'ADD_TRACK', id: newId() })}>
            ＋ Track
          </button>
        </div>
        <MasterSection state={state} controls={controls} dispatch={dispatch} meterRef={meterRef} />
      </div>

      <SessionBar state={state} controls={controls} dispatch={dispatch} />
      </div>

      {!state.audioReady ? (
        <div className="gate" role="dialog" aria-modal="true" aria-label="Start audio">
          <div className="gate__card panel">
            <span className="nameplate gate__wordmark">MTAPE</span>
            <p className="gate__blurb">A browser-native multitrack tape recorder. Audio starts only when you say so.</p>
            <button type="button" className="gate__start" onClick={() => void controls.start()}>
              Start audio
            </button>
            {/* The status banner lives inside the inert wrapper, so a start
                failure (e.g. a stale post-deploy engine chunk) would be invisible
                behind the gate — surface it here with a reload affordance. (M3) */}
            {state.status ? (
              <div className="gate__error readout" role="alert">
                <span>{state.status}</span>
                <button type="button" className="gate__reload" onClick={() => window.location.reload()}>
                  Reload
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
