// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Timeline } from './Timeline'
import { initialState, reducer, type AppState } from '../app/state'
import type { UiControls } from '../app/useEngine'
import { defaultSession, type Clip } from '../audio/contracts'

function stubControls(): UiControls {
  return new Proxy({} as UiControls, { get: () => vi.fn() })
}

function stateWithClip(): AppState {
  const base = initialState(defaultSession('s'))
  const clip: Clip = { id: 'c1', audioId: 'a1', startSec: 4, offsetSec: 0, durationSec: 8, gainDb: 0, fades: { inSec: 0, outSec: 0 } }
  return reducer(base, { type: 'ADD_CLIP', trackId: base.session.tracks[0].id, clip })
}

describe('Timeline', () => {
  it('renders a clip positioned by its start/duration', () => {
    const posRef = { current: 0 }
    render(<Timeline state={stateWithClip()} controls={stubControls()} dispatch={vi.fn()} posRef={posRef} />)
    const clip = screen.getByRole('button', { name: /Clip/ })
    expect(clip).toBeInTheDocument()
    expect(clip.style.left).toBe('320px') // 4s * 80px/s
  })

  it('selects a clip on pointer down', () => {
    const posRef = { current: 0 }
    const dispatch = vi.fn()
    render(<Timeline state={stateWithClip()} controls={stubControls()} dispatch={dispatch} posRef={posRef} />)
    fireEvent.pointerDown(screen.getByRole('button', { name: /Clip/ }))
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'SELECT_CLIP', clipId: 'c1' }))
  })

  it('deletes the selected clip from the toolbar', () => {
    const posRef = { current: 0 }
    const dispatch = vi.fn()
    const s = { ...stateWithClip(), selectedTrackId: 't1', selectedClipId: 'c1' }
    render(<Timeline state={s} controls={stubControls()} dispatch={dispatch} posRef={posRef} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'DELETE_CLIP', clipId: 'c1' }))
  })

  it('splits at the current playhead position', () => {
    const posRef = { current: 6 } // inside the clip (4s..12s)
    const dispatch = vi.fn()
    render(<Timeline state={stateWithClip()} controls={stubControls()} dispatch={dispatch} posRef={posRef} />)
    fireEvent.click(screen.getByRole('button', { name: 'Split' }))
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'SPLIT_CLIP', atSec: 6 }))
  })

  it('does not split when the playhead is outside the selected clip', () => {
    const posRef = { current: 20 } // past the clip end → would create a sliver
    const dispatch = vi.fn()
    render(<Timeline state={stateWithClip()} controls={stubControls()} dispatch={dispatch} posRef={posRef} />)
    fireEvent.click(screen.getByRole('button', { name: 'Split' }))
    expect(dispatch).not.toHaveBeenCalled()
  })
})
