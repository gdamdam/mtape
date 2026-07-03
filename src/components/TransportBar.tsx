// mtape — the transport strip: play/stop/record, the position counter, and the
// timing controls (tempo, meter, metronome + count-in, loop, snap).

import { useEffect, useState, type ChangeEvent, type Dispatch, type FocusEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { Action, AppState } from '../app/state'
import type { UiControls } from '../app/useEngine'
import { COUNT_IN_BARS_MAX, TEMPO_MAX, TEMPO_MIN, TIME_SIG_DENOMINATORS, TIME_SIG_NUMERATOR_MAX, TIME_SIG_NUMERATOR_MIN } from '../audio/contracts'
import { PositionReadout } from './PositionReadout'
import { Toggle } from './primitives'

interface TransportBarProps {
  state: AppState
  controls: UiControls
  dispatch: Dispatch<Action>
  posRef: RefObject<number>
}

interface NumberFieldProps {
  value: string
  onFocus: () => void
  onChange: (e: ChangeEvent<HTMLInputElement>) => void
  onBlur: (e: FocusEvent<HTMLInputElement>) => void
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
}

/** Local edit buffer for a numeric field: while focused the user can clear or
 *  retype freely; the value is only committed (and reducer-clamped) on blur or
 *  Enter — so a mid-edit blank isn't coerced to 0/min per keystroke. When not
 *  editing the field mirrors the committed value (survives a clamp that leaves
 *  the value unchanged). */
function useNumberEdit(value: number, commit: (n: number) => void): NumberFieldProps {
  const [text, setText] = useState(() => String(value))
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setText(String(value))
  }, [value, editing])
  return {
    value: editing ? text : String(value),
    onFocus: () => setEditing(true),
    onChange: (e) => setText(e.currentTarget.value),
    onBlur: (e) => {
      setEditing(false)
      commit(Number(e.currentTarget.value))
    },
    onKeyDown: (e) => {
      if (e.key === 'Enter') e.currentTarget.blur()
    },
  }
}

export function TransportBar({ state, controls, dispatch, posRef }: TransportBarProps): ReactNode {
  const { session, playing, recording } = state
  const tempoField = useNumberEdit(session.tempo, (tempo) => dispatch({ type: 'SET_TEMPO', tempo }))
  const numeratorField = useNumberEdit(session.timeSignature.numerator, (numerator) =>
    dispatch({ type: 'SET_TIME_SIG', timeSignature: { ...session.timeSignature, numerator } }),
  )
  return (
    <section className="transport panel" aria-label="Transport">
      <div className="transport__buttons">
        <button
          type="button"
          className={`transport__btn${playing && !recording ? ' is-play' : ''}`}
          aria-label={playing ? 'Stop' : 'Play'}
          aria-pressed={playing}
          onClick={() => (playing ? controls.stop() : controls.play())}
        >
          {playing ? '⏹' : '⏵'}
        </button>
        <button
          type="button"
          className={`transport__btn transport__btn--record${recording ? ' is-record' : ''}`}
          aria-label="Record"
          aria-pressed={recording}
          disabled={recording}
          onClick={() => controls.record()}
        >
          ⏺
        </button>
      </div>

      <PositionReadout posRef={posRef} tempo={session.tempo} timeSignature={session.timeSignature} />

      <div className="transport__timing">
        <label className="field field--inline">
          <span className="label">Tempo</span>
          <input className="readout input--num" type="number" min={TEMPO_MIN} max={TEMPO_MAX} {...tempoField} />
        </label>

        <fieldset className="field field--inline transport__timesig">
          <legend className="label">Meter</legend>
          <input className="readout input--num input--sig" type="number" aria-label="Beats per bar" min={TIME_SIG_NUMERATOR_MIN} max={TIME_SIG_NUMERATOR_MAX} {...numeratorField} />
          <span aria-hidden="true">/</span>
          <select
            className="readout"
            aria-label="Beat unit"
            value={session.timeSignature.denominator}
            onChange={(e) => dispatch({ type: 'SET_TIME_SIG', timeSignature: { ...session.timeSignature, denominator: Number(e.currentTarget.value) } })}
          >
            {TIME_SIG_DENOMINATORS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </fieldset>

        <Toggle label="Metro" pressed={session.metronome} onToggle={() => dispatch({ type: 'TOGGLE_METRONOME' })} title="Metronome" />

        <label className="field field--inline">
          <span className="label">Count-in</span>
          <select
            className="readout"
            value={session.countInBars}
            onChange={(e) => dispatch({ type: 'SET_COUNT_IN', countInBars: Number(e.currentTarget.value) })}
          >
            {Array.from({ length: COUNT_IN_BARS_MAX + 1 }, (_, n) => (
              <option key={n} value={n}>
                {n === 0 ? 'off' : `${n} bar${n > 1 ? 's' : ''}`}
              </option>
            ))}
          </select>
        </label>

        <Toggle label="Loop" pressed={session.loop.enabled} onToggle={() => dispatch({ type: 'TOGGLE_LOOP' })} tone="cyan" title="Loop region" />
        <Toggle label="Snap" pressed={state.snapToBar} onToggle={() => dispatch({ type: 'TOGGLE_SNAP' })} tone="cyan" title="Snap to bar" />
      </div>
    </section>
  )
}
