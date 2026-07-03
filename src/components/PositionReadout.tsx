// mtape — the transport counter. Reads the playhead position from a ref every
// frame (never React state) and prints bars:beats:ticks plus mm:ss.mmm, exactly
// like a deck's mechanical counter beside a digital time display.

import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import type { TimeSignature } from '../audio/contracts'
import { formatBarsBeats, secToBarsBeats } from '../transport/timing'
import { usePrefersReducedMotion } from './uiHelpers'

interface PositionReadoutProps {
  posRef: RefObject<number>
  tempo: number
  timeSignature: TimeSignature
}

function formatClock(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  const ms = Math.floor((sec - Math.floor(sec)) * 1000)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

export function PositionReadout({ posRef, tempo, timeSignature }: PositionReadoutProps): ReactNode {
  const barsRef = useRef<HTMLSpanElement | null>(null)
  const clockRef = useRef<HTMLSpanElement | null>(null)
  const reduced = usePrefersReducedMotion()

  useEffect(() => {
    let raf = 0
    let timer: ReturnType<typeof setInterval> | undefined
    let lastSec = -1
    const paint = (): void => {
      const sec = posRef.current
      if (sec === lastSec) return
      lastSec = sec
      if (barsRef.current) barsRef.current.textContent = formatBarsBeats(secToBarsBeats(sec, tempo, timeSignature))
      if (clockRef.current) clockRef.current.textContent = formatClock(sec)
    }
    paint()
    if (reduced) {
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
  }, [posRef, tempo, timeSignature, reduced])

  return (
    <div className="position-readout readout">
      <span ref={barsRef} className="position-readout__bars">
        {formatBarsBeats(secToBarsBeats(0, tempo, timeSignature))}
      </span>
      <span ref={clockRef} className="position-readout__clock">
        {formatClock(0)}
      </span>
    </div>
  )
}
