// @vitest-environment jsdom
import { useReducer, useRef, type ReactNode } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { initialState, reducer } from './state'
import { useEngine, type UiControls } from './useEngine'
import { createMockEngine, type MockEngine } from './testMockEngine'
import { defaultSession } from '../audio/contracts'
import { putAudio, putSession } from '../persistence/db'
import { encodeSessionLink } from '../sharing/sessionLink'

// db and the sharing codec are stubbed so we can assert what the hook persists /
// encodes without a real IndexedDB or large-payload boundary.
vi.mock('../persistence/db', () => ({
  putAudio: vi.fn(async () => {}),
  putSession: vi.fn(async () => {}),
  getAudio: vi.fn(async () => undefined),
  getSession: vi.fn(async () => undefined),
}))
vi.mock('../sharing/sessionLink', () => ({
  encodeSessionLink: vi.fn(() => 'tok'),
  decodeSessionLink: vi.fn(() => null),
}))

// The mbus client is faked so tests can push directory snapshots and assert
// what the hook exposes to the picker (no bridge, no WebSocket).
const mbus = vi.hoisted(() => {
  const sourcesCbs: Array<(s: Array<{ sourceId: string; name: string; clientId: string }>) => void> = []
  const client = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    getState: vi.fn(() => 'connected'),
    onState: vi.fn(() => () => {}),
    getClientId: vi.fn(() => 'own-client'),
    getSources: vi.fn((): Array<{ sourceId: string; name: string; clientId: string }> => []),
    onSources: vi.fn((cb: (s: Array<{ sourceId: string; name: string; clientId: string }>) => void) => {
      sourcesCbs.push(cb)
      return () => {}
    }),
    publishOutput: vi.fn(),
    subscribe: vi.fn(),
  }
  return { client, sourcesCbs, pushSources: (s: Array<{ sourceId: string; name: string; clientId: string }>) => sourcesCbs.forEach((cb) => cb(s)) }
})
vi.mock('../transport/mbus', () => ({
  createMbusClient: vi.fn(() => mbus.client),
}))

afterEach(() => {
  vi.clearAllMocks()
})

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
      <span data-testid="clipStart">{state.session.tracks[0].clips[0]?.startSec ?? ''}</span>
      <span data-testid="status">{state.status ?? ''}</span>
      <button onClick={() => void controls.start()}>start</button>
      <button onClick={() => controls.play()}>play</button>
      <button onClick={() => void controls.chooseInput(firstTrack, 'tab')}>tab</button>
      <button onClick={() => dispatch({ type: 'SET_TEMPO', tempo: 140 })}>tempo</button>
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

  it('persists a completed take as a NON-empty WAV — loadAudio must not detach the encode buffers (H1)', async () => {
    const engine = createMockEngine()
    render(<Harness engine={engine} />)
    await startAudio()
    const samples = new Float32Array(100).fill(0.5)
    await act(async () => {
      engine.emit({ type: 'recordChunk', trackId: 't1', audioId: 'recX', channels: [samples], startFrame: 0 })
      engine.emit({ type: 'recordComplete', trackId: 't1', audioId: 'recX', startSec: 0, durationSec: 100 / 48000 })
    })
    // finalizeRecording awaits putAudio; let the microtask/timer flush.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    const put = putAudio as unknown as Mock
    expect(put).toHaveBeenCalled()
    const blob = put.mock.calls.at(-1)![1] as Blob
    // 44-byte header only == an empty (detached) take; 100 mono 16-bit frames add 200 bytes.
    expect(blob.size).toBeGreaterThan(44)
  })

  it('places a take at the engine-reported start without re-compensating latency (H2)', async () => {
    const engine = createMockEngine({ latencySec: 0.03 })
    render(<Harness engine={engine} />)
    await startAudio()
    await act(async () => {
      engine.emit({ type: 'recordComplete', trackId: 't1', audioId: 'r', startSec: 1, durationSec: 2 })
    })
    // ev.startSec is already latency-compensated upstream; it must land verbatim.
    expect(screen.getByTestId('clipStart').textContent).toBe('1')
  })

  it('does not re-post the arrangement when only tempo changes (L12)', async () => {
    const engine = createMockEngine()
    render(<Harness engine={engine} />)
    await startAudio()
    const arrCount = engine.arrangements.length
    const tempoCount = engine.calls.filter((c) => c.method === 'setTempo').length
    await act(async () => {
      fireEvent.click(screen.getByText('tempo'))
    })
    expect(engine.arrangements.length).toBe(arrCount) // arrangement unchanged → not re-posted
    expect(engine.calls.filter((c) => c.method === 'setTempo').length).toBe(tempoCount + 1)
  })

  it('surfaces an error and copies nothing when the share link is oversize (H8)', async () => {
    ;(encodeSessionLink as unknown as Mock).mockReturnValueOnce(null)
    let ctrls: UiControls | undefined
    render(<Harness engine={createMockEngine()} onControls={(c) => (ctrls = c)} />)
    await act(async () => {
      await ctrls!.copyShareLink()
    })
    expect(screen.getByTestId('status').textContent).toMatch(/too large/i)
    expect(location.hash).not.toContain('tok')
  })

  it('skips autosave for a pristine session but persists after an edit (M11)', async () => {
    vi.useFakeTimers()
    try {
      render(<Harness engine={createMockEngine()} />)
      await act(async () => {
        vi.advanceTimersByTime(700)
      })
      expect(putSession as unknown as Mock).not.toHaveBeenCalled()
      await act(async () => {
        fireEvent.click(screen.getByText('tempo'))
      })
      await act(async () => {
        vi.advanceTimersByTime(700)
      })
      expect(putSession as unknown as Mock).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('builds only one engine for two concurrent start() calls (M12)', async () => {
    let count = 0
    function M(): ReactNode {
      const [state, dispatch] = useReducer(reducer, undefined, () => initialState(defaultSession('t')))
      const ref = useRef(state)
      ref.current = state
      const { controls } = useEngine(dispatch, ref, {
        createEngine: () => {
          count++
          return createMockEngine()
        },
      })
      return (
        <button
          onClick={() => {
            void controls.start()
            void controls.start()
          }}
        >
          double-start
        </button>
      )
    }
    render(<M />)
    await act(async () => {
      fireEvent.click(screen.getByText('double-start'))
    })
    expect(count).toBe(1)
  })

  it('surfaces a reload prompt when the engine import fails, without hanging the gate (M3)', async () => {
    function M(): ReactNode {
      const [state, dispatch] = useReducer(reducer, undefined, () => initialState(defaultSession('t')))
      const ref = useRef(state)
      ref.current = state
      const { controls } = useEngine(dispatch, ref, {
        // Simulate the lazy AudioEngine chunk 404-ing on a stale post-deploy tab.
        createEngine: () => {
          throw new Error('Failed to fetch dynamically imported module')
        },
      })
      return (
        <div>
          <span data-testid="m3-ready">{String(state.audioReady)}</span>
          <span data-testid="m3-status">{state.status ?? ''}</span>
          <button onClick={() => void controls.start()}>m3-start</button>
        </div>
      )
    }
    render(<M />)
    await act(async () => {
      fireEvent.click(screen.getByText('m3-start'))
    })
    expect(screen.getByTestId('m3-ready').textContent).toBe('false')
    expect(screen.getByTestId('m3-status').textContent).toMatch(/new version/i)
  })

  it('hides this tab’s own publications from the mbus source picker', async () => {
    const engine = createMockEngine()
    function MbusHarness(): ReactNode {
      const [state, dispatch] = useReducer(reducer, undefined, () => initialState(defaultSession('t')))
      const stateRef = useRef(state)
      stateRef.current = state
      const { controls, mbusSources } = useEngine(dispatch, stateRef, { createEngine: () => engine })
      const firstTrack = state.session.tracks[0].id
      return (
        <div>
          <span data-testid="sources">{mbusSources.map((s) => s.sourceId).join(',')}</span>
          <button onClick={() => void controls.chooseInput(firstTrack, 'mbus')}>mbus-in</button>
        </div>
      )
    }
    render(<MbusHarness />)
    await act(async () => {
      fireEvent.click(screen.getByText('mbus-in'))
    })
    await act(async () => {
      mbus.pushSources([
        { sourceId: 's1', name: 'mdrone', clientId: 'other-client' },
        { sourceId: 's2', name: 'mtape', clientId: 'own-client' },
      ])
    })
    expect(screen.getByTestId('sources').textContent).toBe('s1')
  })

  it('seeds the picker from a directory snapshot that arrived before discovery started', async () => {
    // The publish toggle can connect the shared client first; by the time the
    // user picks the mbus input, the only snapshot may already have been
    // delivered. onSources does not replay it, so the hook must seed from
    // getSources() — filtered the same way.
    mbus.client.getSources.mockReturnValueOnce([
      { sourceId: 's1', name: 'mdrone', clientId: 'other-client' },
      { sourceId: 's2', name: 'mtape', clientId: 'own-client' },
    ])
    const engine = createMockEngine()
    function SeedHarness(): ReactNode {
      const [state, dispatch] = useReducer(reducer, undefined, () => initialState(defaultSession('t')))
      const stateRef = useRef(state)
      stateRef.current = state
      const { controls, mbusSources } = useEngine(dispatch, stateRef, { createEngine: () => engine })
      const firstTrack = state.session.tracks[0].id
      return (
        <div>
          <span data-testid="seeded">{mbusSources.map((s) => s.sourceId).join(',')}</span>
          <button onClick={() => void controls.chooseInput(firstTrack, 'mbus')}>seed-mbus-in</button>
        </div>
      )
    }
    render(<SeedHarness />)
    await act(async () => {
      fireEvent.click(screen.getByText('seed-mbus-in'))
    })
    expect(screen.getByTestId('seeded').textContent).toBe('s1')
  })
})
