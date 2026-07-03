// mtape — a rotary knob. The rotation is purely visual; a real range input
// underneath carries the value, keyboard support, and accessibility. Dragging
// the range (or arrow keys / wheel via the browser) turns the cap.

import { useId, type CSSProperties, type ReactNode } from 'react'

interface KnobProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  /** Rendered numeric readout (already formatted for its unit). */
  display: string
  onChange: (value: number) => void
  tone?: 'amber' | 'cyan'
}

// Sweep the cap across a 270° arc, the conventional analogue throw.
const ARC_DEG = 270
const START_DEG = -135

export function Knob({ label, value, min, max, step = 0.1, display, onChange, tone = 'amber' }: KnobProps): ReactNode {
  const id = useId()
  const frac = max > min ? (value - min) / (max - min) : 0
  const angle = START_DEG + frac * ARC_DEG
  return (
    <div className={`knob knob--${tone}`}>
      <span className="label knob__label" id={`${id}-label`}>
        {label}
      </span>
      <div className="knob__dial" aria-hidden="true" style={{ '--knob-angle': `${angle}deg` } as CSSProperties}>
        <span className="knob__pointer" />
      </div>
      <input
        id={id}
        className="knob__input"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-labelledby={`${id}-label`}
        aria-valuetext={display}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      />
      <span className="readout knob__readout">{display}</span>
    </div>
  )
}
