// mtape — a VU-legend bar meter (green → amber → red). It reads the LIVE level
// through a getter every animation frame and writes straight to the DOM node,
// so the 30–60 Hz meter stream never touches React state. When the user prefers
// reduced motion we sample on a slow interval instead of every frame.

import { useEffect, useRef, type ReactNode } from 'react'
import { usePrefersReducedMotion } from './uiHelpers'

interface MeterProps {
  /** Latest peak level in 0..1, sampled on demand from a ref. */
  getLevel: () => number
  /** Optional clip indicator (master over-ceiling). */
  getClip?: () => boolean
  orientation?: 'vertical' | 'horizontal'
  label?: string
}

export function Meter({ getLevel, getClip, orientation = 'vertical', label }: MeterProps): ReactNode {
  const fillRef = useRef<HTMLDivElement | null>(null)
  const clipRef = useRef<HTMLDivElement | null>(null)
  const reduced = usePrefersReducedMotion()

  useEffect(() => {
    let raf = 0
    let timer: ReturnType<typeof setInterval> | undefined
    const paint = (): void => {
      const level = Math.max(0, Math.min(1, getLevel()))
      const fill = fillRef.current
      if (fill) {
        const pct = `${(level * 100).toFixed(1)}%`
        if (orientation === 'vertical') fill.style.height = pct
        else fill.style.width = pct
      }
      if (clipRef.current && getClip) clipRef.current.classList.toggle('is-lit', getClip())
    }
    paint() // paint once synchronously so the meter is correct before the loop
    if (reduced) {
      // ~8 Hz keeps the reading meaningful without continuous churn.
      timer = setInterval(paint, 125)
    } else {
      const loop = (): void => {
        paint()
        raf = requestAnimationFrame(loop)
      }
      raf = requestAnimationFrame(loop)
    }
    return () => {
      if (raf) cancelAnimationFrame(raf)
      if (timer) clearInterval(timer)
    }
  }, [getLevel, getClip, orientation, reduced])

  return (
    <div className={`meter meter--${orientation}`} role="meter" aria-label={label ?? 'level'} aria-hidden="true">
      <div className="meter__track">
        <div ref={fillRef} className="meter__fill" />
      </div>
      {getClip ? <div ref={clipRef} className="meter__clip" title="clip" /> : null}
    </div>
  )
}
