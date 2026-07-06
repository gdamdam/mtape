// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { RefObject } from 'react'
import { TrackStrip } from './TrackStrip'
import type { MeterSnapshot, UiControls } from '../app/useEngine'
import { defaultSession, type Track } from '../audio/contracts'

function stubControls(): UiControls {
  return new Proxy({} as UiControls, { get: () => vi.fn() })
}

function track(over: Partial<Track> = {}): Track {
  return { ...defaultSession('s').tracks[0], ...over }
}

const meterRef = { current: null } as RefObject<MeterSnapshot | null>

describe('TrackStrip', () => {
  it('disarms a lit arm toggle (M10)', () => {
    const dispatch = vi.fn()
    const t = track({ armed: true })
    render(<TrackStrip track={t} index={0} selected={false} canRemove controls={stubControls()} dispatch={dispatch} meterRef={meterRef} mbusSources={[]} mbusSourceId="" />)
    fireEvent.click(screen.getByTitle('Record-arm'))
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_TRACK_PARAM', trackId: t.id, patch: { armed: false } })
  })

  it('arms an unlit arm toggle', () => {
    const dispatch = vi.fn()
    const t = track({ armed: false })
    render(<TrackStrip track={t} index={0} selected={false} canRemove controls={stubControls()} dispatch={dispatch} meterRef={meterRef} mbusSources={[]} mbusSourceId="" />)
    fireEvent.click(screen.getByTitle('Record-arm'))
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_TRACK_PARAM', trackId: t.id, patch: { armed: true } })
  })

  it('commits the track name on blur, not per keystroke (M13)', () => {
    const dispatch = vi.fn()
    const t = track({ name: 'Track 1' })
    render(<TrackStrip track={t} index={0} selected={false} canRemove controls={stubControls()} dispatch={dispatch} meterRef={meterRef} mbusSources={[]} mbusSourceId="" />)
    const input = screen.getByLabelText('Track name')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '' } }) // cleared mid-edit — must not snap back
    fireEvent.change(input, { target: { value: 'Drums' } })
    expect(dispatch).not.toHaveBeenCalled()
    fireEvent.blur(input)
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_TRACK_PARAM', trackId: t.id, patch: { name: 'Drums' } })
  })
})
