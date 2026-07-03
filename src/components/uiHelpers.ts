// mtape — tiny UI-only helpers shared across components. No JSX here so the
// react-refresh "only export components" rule stays quiet in the .tsx files.

import { useEffect, useState } from 'react'

/** Format a dB value with a sign and one decimal, matching the deck's readouts. */
export function formatDb(db: number): string {
  if (db <= -60) return '-∞'
  const rounded = Math.round(db * 10) / 10
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}`
}

/** Format a signed integer dB (EQ bands) without a decimal. */
export function formatDbInt(db: number): string {
  const r = Math.round(db)
  return `${r > 0 ? '+' : ''}${r}`
}

/** Format a 0..1 amount as a percentage. */
export function formatPct(amount: number): string {
  return `${Math.round(amount * 100)}%`
}

/** Format L/C/R pan. */
export function formatPan(pan: number): string {
  if (Math.abs(pan) < 0.005) return 'C'
  const side = pan < 0 ? 'L' : 'R'
  return `${side}${Math.round(Math.abs(pan) * 100)}`
}

/** Live subscription to the reduced-motion preference so animation loops can
 *  stand down when the user asks for less motion. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return
    const mq = matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (): void => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}
