// mtape — small presentational primitives shared by the panels: a labelled
// field wrapper and a two-state toggle button silkscreened onto the deck.

import type { ReactNode } from 'react'

interface FieldProps {
  label: string
  children: ReactNode
  /** Associate the label with a control for assistive tech. */
  htmlFor?: string
  className?: string
}

/** A silkscreen label stacked above (or beside) a control. */
export function Field({ label, children, htmlFor, className }: FieldProps): ReactNode {
  return (
    <label className={`field${className ? ` ${className}` : ''}`} htmlFor={htmlFor}>
      <span className="label field__label">{label}</span>
      {children}
    </label>
  )
}

interface ToggleProps {
  label: string
  pressed: boolean
  onToggle: () => void
  /** Accent theme: amber (default), record red, or play green. */
  tone?: 'amber' | 'record' | 'play' | 'cyan'
  title?: string
  disabled?: boolean
}

/** A latching panel switch; `aria-pressed` communicates the lit/unlit state. */
export function Toggle({ label, pressed, onToggle, tone = 'amber', title, disabled }: ToggleProps): ReactNode {
  return (
    <button
      type="button"
      className={`toggle toggle--${tone}${pressed ? ' is-on' : ''}`}
      aria-pressed={pressed}
      onClick={onToggle}
      title={title}
      disabled={disabled}
    >
      {label}
    </button>
  )
}
