// mtape — the transport strip: play/stop/record, the position counter, and the
// timing controls (tempo, meter, metronome + count-in, loop, snap).

import { type Dispatch, type ReactNode, type RefObject } from 'react'
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

export function TransportBar({ state, controls, dispatch, posRef }: TransportBarProps): ReactNode {
  const { session, playing, recording } = state
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
          onClick={() => controls.record()}
        >
          ⏺
        </button>
      </div>

      <PositionReadout posRef={posRef} tempo={session.tempo} timeSignature={session.timeSignature} />

      <div className="transport__timing">
        <label className="field field--inline">
          <span className="label">Tempo</span>
          <input
            className="readout input--num"
            type="number"
            min={TEMPO_MIN}
            max={TEMPO_MAX}
            value={session.tempo}
            onChange={(e) => dispatch({ type: 'SET_TEMPO', tempo: Number(e.currentTarget.value) })}
          />
        </label>

        <fieldset className="field field--inline transport__timesig">
          <legend className="label">Meter</legend>
          <input
            className="readout input--num input--sig"
            type="number"
            aria-label="Beats per bar"
            min={TIME_SIG_NUMERATOR_MIN}
            max={TIME_SIG_NUMERATOR_MAX}
            value={session.timeSignature.numerator}
            onChange={(e) => dispatch({ type: 'SET_TIME_SIG', timeSignature: { ...session.timeSignature, numerator: Number(e.currentTarget.value) } })}
          />
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
