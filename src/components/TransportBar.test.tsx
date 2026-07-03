// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TransportBar } from './TransportBar'
import { initialState } from '../app/state'
import type { UiControls } from '../app/useEngine'
import { defaultSession } from '../audio/contracts'

function spyControls(): UiControls {
  return {
    start: vi.fn(),
    play: vi.fn(),
    stop: vi.fn(),
    record: vi.fn(),
    seek: vi.fn(),
    armTrack: vi.fn(),
    chooseInput: vi.fn(),
    importFile: vi.fn(),
    mixdown: vi.fn(),
    exportStems: vi.fn(),
    saveSession: vi.fn(),
    loadSession: vi.fn(),
    newSession: vi.fn(),
    exportJson: vi.fn(),
    importJson: vi.fn(),
    copyShareLink: vi.fn(),
  } as unknown as UiControls
}

describe('TransportBar', () => {
  it('calls play when stopped and stop when playing', () => {
    const controls = spyControls()
    const posRef = { current: 0 }
    const { rerender } = render(<TransportBar state={initialState(defaultSession('s'))} controls={controls} dispatch={vi.fn()} posRef={posRef} />)
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(controls.play).toHaveBeenCalledTimes(1)

    const playing = { ...initialState(defaultSession('s')), playing: true }
    rerender(<TransportBar state={playing} controls={controls} dispatch={vi.fn()} posRef={posRef} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(controls.stop).toHaveBeenCalledTimes(1)
  })

  it('commits a tempo edit on blur (not per keystroke)', () => {
    const dispatch = vi.fn()
    const posRef = { current: 0 }
    render(<TransportBar state={initialState(defaultSession('s'))} controls={spyControls()} dispatch={dispatch} posRef={posRef} />)
    const input = screen.getByLabelText(/tempo/i)
    fireEvent.focus(input)
    // Clearing/retyping must NOT dispatch mid-edit (else '' → 0 → snapped to min).
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.change(input, { target: { value: '140' } })
    expect(dispatch).not.toHaveBeenCalled()
    fireEvent.blur(input)
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_TEMPO', tempo: 140 })
  })

  it('disables the Record button while recording (no double-record)', () => {
    const controls = spyControls()
    const posRef = { current: 0 }
    const recording = { ...initialState(defaultSession('s')), playing: true, recording: true }
    render(<TransportBar state={recording} controls={controls} dispatch={vi.fn()} posRef={posRef} />)
    const rec = screen.getByRole('button', { name: 'Record' })
    expect(rec).toBeDisabled()
    fireEvent.click(rec)
    expect(controls.record).not.toHaveBeenCalled()
  })

  it('toggles snap-to-bar', () => {
    const dispatch = vi.fn()
    const posRef = { current: 0 }
    render(<TransportBar state={initialState(defaultSession('s'))} controls={spyControls()} dispatch={dispatch} posRef={posRef} />)
    fireEvent.click(screen.getByRole('button', { name: 'Snap' }))
    expect(dispatch).toHaveBeenCalledWith({ type: 'TOGGLE_SNAP' })
  })
})
