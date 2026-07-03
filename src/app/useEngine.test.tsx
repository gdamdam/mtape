// @vitest-environment jsdom
import { useReducer, useRef, type ReactNode } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { initialState, reducer } from './state'
import { useEngine, type UiControls } from './useEngine'
import { createMockEngine, type MockEngine } from './testMockEngine'
import { defaultSession } from '../audio/contracts'

/** Mount a real reducer + useEngine wired to an injected mock engine. */
function Harness({ engine, onControls }: { engine: MockEngine; onControls?: (c: UiControls) => void }): ReactNode {
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState(defaultSession('t')))
  const stateRef = useRef(state)
  stateRef.current = state
  const { controls } = useEngine(dispatch, stateRef, { createEngine: () => engine })
  onControls?.(controls)
  const firstTrack = state.session.tracks[0].id
  return (
    <div>
      <span data-testid="ready">{String(state.audioReady)}</span>
      <span data-testid="playing">{String(state.playing)}</span>
      <span data-testid="clips">{state.session.tracks[0].clips.length}</span>
      <span data-testid="status">{state.status ?? ''}</span>
      <button onClick={() => void controls.start()}>start</button>
      <button onClick={() => controls.play()}>play</button>
      <button onClick={() => void controls.chooseInput(firstTrack, 'tab')}>tab</button>
    </div>
  )
}

async function startAudio(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByText('start'))
  })
}

describe('useEngine bridge', () => {
  it('starts the engine on a user gesture and flips audioReady', async () => {
    const engine = createMockEngine()
    render(<Harness engine={engine} />)
    expect(screen.getByTestId('ready').textContent).toBe('false')
    await startAudio()
    expect(screen.getByTestId('ready').textContent).toBe('true')
    expect(engine.calls.some((c) => c.method === 'start')).toBe(true)
  })

  it('pushes declarative state to the engine once audio is live', async () => {
    const engine = createMockEngine()
    render(<Harness engine={engine} />)
    await startAudio()
    expect(engine.calls.some((c) => c.method === 'setTempo')).toBe(true)
    expect(engine.arrangements.length).toBeGreaterThan(0)
  })

  it('adds a clip on the armed track when a take completes', async () => {
    const engine = createMockEngine()
    render(<Harness engine={engine} />)
    await startAudio()
    expect(screen.getByTestId('clips').textContent).toBe('0')
    await act(async () => {
      engine.emit({ type: 'recordComplete', trackId: 't1', audioId: 'rec1', startSec: 1, durationSec: 2 })
    })
    expect(screen.getByTestId('clips').textContent).toBe('1')
  })

  it('stops transport on an ended event', async () => {
    const engine = createMockEngine()
    render(<Harness engine={engine} />)
    await startAudio()
    await act(async () => {
      fireEvent.click(screen.getByText('play'))
    })
    expect(screen.getByTestId('playing').textContent).toBe('true')
    await act(async () => {
      engine.emit({ type: 'ended' })
    })
    expect(screen.getByTestId('playing').textContent).toBe('false')
  })

  it('surfaces a status message when tab capture is unavailable', async () => {
    const engine = createMockEngine({ failTab: true })
    render(<Harness engine={engine} />)
    await startAudio()
    await act(async () => {
      fireEvent.click(screen.getByText('tab'))
    })
    expect(screen.getByTestId('status').textContent).toMatch(/Chromium-desktop/i)
  })

  it('does not touch position/meter through React state (refs only)', async () => {
    const engine = createMockEngine()
    render(<Harness engine={engine} />)
    await startAudio()
    // Emitting a flood of hot-path events must not throw or re-render into error.
    await act(async () => {
      for (let i = 0; i < 5; i++) {
        engine.emit({ type: 'position', positionSec: i, playing: true, recording: false })
        engine.emit({ type: 'meters', masterPeakL: 0.5, masterPeakR: 0.4, masterRms: 0.3, clip: false, tracks: [] })
      }
    })
    expect(screen.getByTestId('clips').textContent).toBe('0')
  })
})
