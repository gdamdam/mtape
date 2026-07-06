// mtape — the master bus panel: output gain, soft-clip drive, limiter ceiling,
// varispeed, the master meter with a clip LED, and the mixdown/stems bounce
// controls with a bit-depth choice.

import { useCallback, useState, type Dispatch, type ReactNode, type RefObject } from 'react'
import type { Action, AppState } from '../app/state'
import type { MeterSnapshot, UiControls } from '../app/useEngine'
import type { BitDepth } from '../recording/wav'
import {
  DRIVE_MAX,
  DRIVE_MIN,
  GAIN_DB_MAX,
  GAIN_DB_MIN,
  LIMITER_CEILING_DB_MAX,
  LIMITER_CEILING_DB_MIN,
  VARISPEED_MAX,
  VARISPEED_MIN,
} from '../audio/contracts'
import { Fader } from './Fader'
import { Knob } from './Knob'
import { Meter } from './Meter'
import { formatDb, formatPct } from './uiHelpers'

interface MasterSectionProps {
  state: AppState
  controls: UiControls
  dispatch: Dispatch<Action>
  meterRef: RefObject<MeterSnapshot | null>
}

export function MasterSection({ state, controls, dispatch, meterRef }: MasterSectionProps): ReactNode {
  const { master } = state.session
  const [bitDepth, setBitDepth] = useState<BitDepth>(16)
  // mbus publish intent — session-transient, off by default.
  const [busOn, setBusOn] = useState(false)

  // Stable getter identities so Meter's rAF loop isn't torn down on every
  // dispatch (each reducer render otherwise minted fresh closures).
  const level = useCallback((): number => {
    const m = meterRef.current
    return m ? Math.max(m.masterPeakL, m.masterPeakR) : 0
  }, [meterRef])
  const clip = useCallback((): boolean => meterRef.current?.clip ?? false, [meterRef])

  return (
    <section className="master panel" aria-label="Master">
      <h2 className="nameplate master__title">Master</h2>

      <div className="master__controls">
        <Fader label="Out" valueDb={master.gainDb} min={GAIN_DB_MIN} max={GAIN_DB_MAX} onChange={(gainDb) => dispatch({ type: 'SET_MASTER', patch: { gainDb } })} />
        <Meter getLevel={level} getClip={clip} label="Master level" />
        <div className="master__knobs">
          <Knob label="Drive" value={master.drive} min={DRIVE_MIN} max={DRIVE_MAX} step={0.01} display={formatPct(master.drive)} onChange={(drive) => dispatch({ type: 'SET_MASTER', patch: { drive } })} />
          <Knob label="Ceil" value={master.limiterCeilingDb} min={LIMITER_CEILING_DB_MIN} max={LIMITER_CEILING_DB_MAX} step={0.1} display={formatDb(master.limiterCeilingDb)} onChange={(limiterCeilingDb) => dispatch({ type: 'SET_MASTER', patch: { limiterCeilingDb } })} />
          <Knob label="Vari" value={master.varispeed} min={VARISPEED_MIN} max={VARISPEED_MAX} step={0.01} display={`${master.varispeed.toFixed(2)}×`} onChange={(varispeed) => dispatch({ type: 'SET_MASTER', patch: { varispeed } })} tone="cyan" />
        </div>
      </div>

      <div className="master__bounce">
        <label className="field field--inline">
          <span className="label">Bit depth</span>
          <select className="readout" value={bitDepth} onChange={(e) => setBitDepth(Number(e.currentTarget.value) as BitDepth)}>
            <option value={16}>16-bit</option>
            <option value={24}>24-bit</option>
          </select>
        </label>
        <button type="button" onClick={() => void controls.mixdown({ region: 'song', bitDepth })}>
          Mixdown song
        </button>
        <button type="button" disabled={!state.session.loop.enabled} onClick={() => void controls.mixdown({ region: 'loop', bitDepth })}>
          Mixdown loop
        </button>
        <button type="button" onClick={() => void controls.exportStems(bitDepth)}>
          Stems
        </button>
        <button
          type="button"
          aria-pressed={busOn}
          title={busOn
            ? 'Publishing the master mix to the mbus patchbay (via the local link-bridge)'
            : 'Publish the master mix to the mbus patchbay (needs the local link-bridge; harmless without it)'}
          onClick={() => {
            const next = !busOn
            setBusOn(next)
            controls.setMbusPublish(next)
          }}
        >
          {busOn ? 'Bus on' : 'Bus'}
        </button>
      </div>
    </section>
  )
}
