// mtape — the arrangement surface. A bar/beat ruler over one lane per track;
// clips are positioned and sized from (startSec, durationSec) with their fades
// drawn as triangles. A clip body drags to move; its edge handles trim in/out
// (snapping to the bar grid when enabled). A single rAF-driven playhead sweeps
// across every lane. The selected clip gets a split/duplicate/delete toolbar.

import { useEffect, useRef, type CSSProperties, type Dispatch, type ReactNode, type RefObject } from 'react'
import type { Action, AppState } from '../app/state'
import type { UiControls } from '../app/useEngine'
import type { Clip, Session, TimeSignature, Track } from '../audio/contracts'
import { clipEndSec } from '../clips/clipMath'
import { secondsPerBar, snapSecToBar } from '../transport/timing'
import { usePrefersReducedMotion } from './uiHelpers'

/** Timeline zoom: pixels per second. A single knob keeps ruler/clips in sync. */
export const PX_PER_SEC = 80
const LANE_HEIGHT = 60

function localId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Longest content extent (plus headroom) so the surface is always scrollable. */
function contentSec(session: Session): number {
  let end = 0
  for (const t of session.tracks) for (const c of t.clips) end = Math.max(end, clipEndSec(c))
  return Math.max(end, 30) + 8
}

interface TimelineProps {
  state: AppState
  controls: UiControls
  dispatch: Dispatch<Action>
  posRef: RefObject<number>
}

export function Timeline({ state, controls, dispatch, posRef }: TimelineProps): ReactNode {
  const { session, selectedTrackId, selectedClipId, snapToBar, showLoopRegion } = state
  const totalSec = contentSec(session)
  const widthPx = totalSec * PX_PER_SEC
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const playheadRef = useRef<HTMLDivElement | null>(null)
  const reduced = usePrefersReducedMotion()

  // Sweep the playhead straight to the DOM; never through React state.
  useEffect(() => {
    let raf = 0
    let timer: ReturnType<typeof setInterval> | undefined
    const paint = (): void => {
      if (playheadRef.current) playheadRef.current.style.transform = `translateX(${posRef.current * PX_PER_SEC}px)`
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
  }, [posRef, reduced])

  const seekFromPointer = (e: React.PointerEvent<HTMLDivElement>): void => {
    // .ruler lives inside the scrolled content, so its rect already reflects the
    // horizontal scroll — adding scrollLeft would count the offset twice.
    const rect = e.currentTarget.getBoundingClientRect()
    const sec = Math.max(0, (e.clientX - rect.left) / PX_PER_SEC)
    controls.seek(sec)
  }

  const spb = secondsPerBar(session.tempo, session.timeSignature)
  const barCount = Math.ceil(totalSec / spb) + 1

  return (
    <section className="timeline panel" aria-label="Timeline">
      <div className="timeline__toolbar">
        <span className="label">Arrangement</span>
        <ClipToolbar state={state} controls={controls} dispatch={dispatch} posRef={posRef} />
      </div>

      <div className="timeline__scroll" ref={scrollRef}>
        <div className="timeline__content" style={{ width: widthPx }}>
          <div className="ruler" role="presentation" onPointerDown={seekFromPointer}>
            {Array.from({ length: barCount }, (_, i) => (
              <div key={i} className="ruler__bar" style={{ left: i * spb * PX_PER_SEC }}>
                <span className="ruler__label">{i + 1}</span>
              </div>
            ))}
          </div>

          {showLoopRegion && session.loop.enabled ? (
            <div
              className="timeline__loop"
              style={{ left: session.loop.startSec * PX_PER_SEC, width: Math.max(0, (session.loop.endSec - session.loop.startSec) * PX_PER_SEC) }}
              aria-hidden="true"
            />
          ) : null}

          <div className="lanes">
            {session.tracks.map((track) => (
              <Lane
                key={track.id}
                track={track}
                tempo={session.tempo}
                timeSignature={session.timeSignature}
                snapToBar={snapToBar}
                selectedClipId={selectedTrackId === track.id ? selectedClipId : null}
                dispatch={dispatch}
              />
            ))}
          </div>

          <div ref={playheadRef} className="timeline__playhead" aria-hidden="true" style={{ height: session.tracks.length * LANE_HEIGHT + 28 }} />
        </div>
      </div>
    </section>
  )
}

interface LaneProps {
  track: Track
  tempo: number
  timeSignature: TimeSignature
  snapToBar: boolean
  selectedClipId: string | null
  dispatch: Dispatch<Action>
}

function Lane({ track, tempo, timeSignature, snapToBar, selectedClipId, dispatch }: LaneProps): ReactNode {
  return (
    <div className="lane" style={{ height: LANE_HEIGHT, '--track-color': track.color } as CSSProperties}>
      {track.clips.map((clip) => (
        <ClipView
          key={clip.id}
          clip={clip}
          trackId={track.id}
          color={track.color}
          selected={clip.id === selectedClipId}
          tempo={tempo}
          timeSignature={timeSignature}
          snapToBar={snapToBar}
          dispatch={dispatch}
        />
      ))}
    </div>
  )
}

interface ClipViewProps {
  clip: Clip
  trackId: string
  color: string
  selected: boolean
  tempo: number
  timeSignature: TimeSignature
  snapToBar: boolean
  dispatch: Dispatch<Action>
}

function ClipView({ clip, trackId, color, selected, tempo, timeSignature, snapToBar, dispatch }: ClipViewProps): ReactNode {
  // A clip with no in-RAM/stored audio still shows its placement — hatched — so a
  // shared arrangement reads correctly even before the audio is rehydrated.
  const beginDrag = (e: React.PointerEvent, mode: 'move' | 'in' | 'out'): void => {
    e.preventDefault()
    e.stopPropagation()
    // Ignore secondary pointers (a second finger) so simultaneous touches can't
    // stack a second drag on the same clip.
    if (!e.isPrimary) return
    const startX = e.clientX
    const pointerId = e.pointerId
    const el = e.currentTarget as HTMLElement
    // Capture the pointer so a drag that leaves the element (or the browser
    // hijacks for scroll) still routes end events here.
    try {
      el.setPointerCapture(pointerId)
    } catch {
      // setPointerCapture can throw if the pointer is already gone; harmless.
    }
    const origStart = clip.startSec
    const origEnd = clipEndSec(clip)
    const snap = (sec: number): number => (snapToBar ? snapSecToBar(sec, tempo, timeSignature) : sec)
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return
      const dxSec = (ev.clientX - startX) / PX_PER_SEC
      if (mode === 'move') dispatch({ type: 'MOVE_CLIP', trackId, clipId: clip.id, startSec: Math.max(0, snap(origStart + dxSec)) })
      else if (mode === 'in') dispatch({ type: 'TRIM_IN', trackId, clipId: clip.id, newStartSec: Math.max(0, snap(origStart + dxSec)) })
      else dispatch({ type: 'TRIM_OUT', trackId, clipId: clip.id, newEndSec: snap(origEnd + dxSec) })
    }
    // pointercancel (touch interruption / scroll) and lostpointercapture end the
    // drag too — without this the move listener leaked and the clip tracked every
    // subsequent pointer forever on touch devices.
    const end = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      window.removeEventListener('lostpointercapture', end)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    window.addEventListener('lostpointercapture', end)
  }

  return (
    <div
      className={`clip${selected ? ' is-selected' : ''}`}
      style={{ left: clip.startSec * PX_PER_SEC, width: Math.max(6, clip.durationSec * PX_PER_SEC), borderColor: color }}
      role="button"
      tabIndex={0}
      aria-label={`Clip ${clip.name ?? clip.audioId}`}
      onPointerDown={(e) => {
        dispatch({ type: 'SELECT_CLIP', trackId, clipId: clip.id })
        beginDrag(e, 'move')
      }}
    >
      <span className="clip__handle clip__handle--in" onPointerDown={(e) => beginDrag(e, 'in')} aria-hidden="true" />
      {clip.fades.inSec > 0 ? <span className="clip__fade clip__fade--in" style={{ width: clip.fades.inSec * PX_PER_SEC }} /> : null}
      <span className="clip__name">{clip.name ?? 'clip'}</span>
      {clip.fades.outSec > 0 ? <span className="clip__fade clip__fade--out" style={{ width: clip.fades.outSec * PX_PER_SEC }} /> : null}
      <span className="clip__handle clip__handle--out" onPointerDown={(e) => beginDrag(e, 'out')} aria-hidden="true" />
    </div>
  )
}

interface ClipToolbarProps {
  state: AppState
  controls: UiControls
  dispatch: Dispatch<Action>
  posRef: RefObject<number>
}

/** Split (at the playhead) / duplicate / delete for the selected clip. */
function ClipToolbar({ state, dispatch, posRef }: ClipToolbarProps): ReactNode {
  const { selectedTrackId, selectedClipId } = state
  const disabled = !selectedTrackId || !selectedClipId
  const act = (make: (trackId: string, clipId: string) => Action): void => {
    if (selectedTrackId && selectedClipId) dispatch(make(selectedTrackId, selectedClipId))
  }
  // Split only when the playhead falls strictly inside the selected clip;
  // splitting outside (or on an edge) would clamp to a degenerate sliver clip.
  const split = (): void => {
    if (!selectedTrackId || !selectedClipId) return
    const clip = state.session.tracks.find((t) => t.id === selectedTrackId)?.clips.find((c) => c.id === selectedClipId)
    if (!clip) return
    const at = posRef.current
    const EPS = 1e-3
    if (at <= clip.startSec + EPS || at >= clipEndSec(clip) - EPS) return
    dispatch({ type: 'SPLIT_CLIP', trackId: selectedTrackId, clipId: selectedClipId, atSec: at, newIdA: localId(), newIdB: localId() })
  }
  return (
    <div className="clip-toolbar" role="group" aria-label="Clip actions">
      <button type="button" disabled={disabled} onClick={split}>
        Split
      </button>
      <button type="button" disabled={disabled} onClick={() => act((trackId, clipId) => ({ type: 'DUPLICATE_CLIP', trackId, clipId, newId: localId() }))}>
        Duplicate
      </button>
      <button type="button" disabled={disabled} onClick={() => act((trackId, clipId) => ({ type: 'DELETE_CLIP', trackId, clipId }))}>
        Delete
      </button>
    </div>
  )
}
