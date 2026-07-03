// mtape — a vertical channel fader. An accessible <input type="range"> does the
// interaction and keyboard work; CSS dresses it as a sliding cap on a track.

import { useId, type ReactNode } from 'react'
import { formatDb } from './uiHelpers'

interface FaderProps {
  label: string
  valueDb: number
  min: number
  max: number
  onChange: (db: number) => void
}

export function Fader({ label, valueDb, min, max, onChange }: FaderProps): ReactNode {
  const id = useId()
  return (
    <div className="fader">
      <span className="label fader__label" id={`${id}-label`}>
        {label}
      </span>
      <input
        id={id}
        className="fader__input"
        type="range"
        min={min}
        max={max}
        step={0.5}
        value={valueDb}
        aria-labelledby={`${id}-label`}
        aria-valuetext={`${formatDb(valueDb)} dB`}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      />
      <span className="readout fader__readout">{formatDb(valueDb)}</span>
    </div>
  )
}
