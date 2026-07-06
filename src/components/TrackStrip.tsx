// mtape — one channel strip per track: name, input source, arm/mute/solo/
// monitor, fader + pan, a 3-band EQ, the tape-character section, and a live
// meter. All edits flow through the reducer; capture/import go through controls.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type Dispatch, type ReactNode, type RefObject } from 'react'
import type { Action } from '../app/state'
import type { MeterSnapshot, UiControls } from '../app/useEngine'
import {
  EQ_GAIN_DB_MAX,
  EQ_GAIN_DB_MIN,
  GAIN_DB_MAX,
  GAIN_DB_MIN,
  PAN_MAX,
  PAN_MIN,
  TAPE_AMOUNT_MAX,
  TAPE_AMOUNT_MIN,
  type Track,
  type TrackInputKind,
} from '../audio/contracts'
import { Fader } from './Fader'
import { Knob } from './Knob'
import { Meter } from './Meter'
import { Toggle } from './primitives'
import { formatDbInt, formatPan, formatPct } from './uiHelpers'

interface TrackStripProps {
  track: Track
  index: number
  selected: boolean
  canRemove: boolean
  controls: UiControls
  dispatch: Dispatch<Action>
  meterRef: RefObject<MeterSnapshot | null>
  /** Advertised mbus sources (empty when the bridge is absent). */
  mbusSources: ReadonlyArray<{ sourceId: string; name: string; clientId: string }>
  /** This track's subscribed mbus sourceId ('' = none picked yet). */
  mbusSourceId: string
}

const INPUT_OPTIONS: ReadonlyArray<{ value: TrackInputKind; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'tab', label: 'Tab' },
  { value: 'mic', label: 'Mic' },
  { value: 'file', label: 'File…' },
  { value: 'mbus', label: 'mbus' },
]

export function TrackStrip({ track, index, selected, canRemove, controls, dispatch, meterRef, mbusSources, mbusSourceId }: TrackStripProps): ReactNode {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const patch = (p: Partial<Track>): void => dispatch({ type: 'SET_TRACK_PARAM', trackId: track.id, patch: p })

  // Local edit buffer for the track name so a mid-edit blank isn't snapped back
  // to the previous name per keystroke; commit on blur / Enter.
  const [nameText, setNameText] = useState(track.name)
  const [editingName, setEditingName] = useState(false)
  useEffect(() => {
    if (!editingName) setNameText(track.name)
  }, [track.name, editingName])

  const onInputChange = (select: HTMLSelectElement): void => {
    const kind = select.value as TrackInputKind
    if (kind === 'file') {
      // The select is controlled by track.input; leaving it on 'file' would make
      // a second "File…" pick fire no onChange (and cancelling the picker would
      // wedge it). Revert the visible selection so the picker always reopens.
      select.value = track.input
      fileInputRef.current?.click()
      return
    }
    void controls.chooseInput(track.id, kind)
  }

  // Stable getter identity so Meter's rAF loop isn't torn down on every dispatch.
  const level = useCallback((): number => meterRef.current?.tracks[track.id]?.peak ?? 0, [meterRef, track.id])

  return (
    <section className={`strip panel${selected ? ' is-selected' : ''}`} aria-label={`Track: ${track.name}`} onClick={() => dispatch({ type: 'SELECT_TRACK', trackId: track.id })}>
      <header className="strip__head" style={{ '--track-color': track.color } as CSSProperties}>
        <span className="strip__num nameplate">{String(index + 1).padStart(2, '0')}</span>
        <input
          className="strip__name"
          aria-label="Track name"
          value={editingName ? nameText : track.name}
          onFocus={() => setEditingName(true)}
          onChange={(e) => setNameText(e.currentTarget.value)}
          onBlur={(e) => {
            setEditingName(false)
            patch({ name: e.currentTarget.value })
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        <button
          type="button"
          className="strip__remove"
          aria-label="Remove track"
          title="Remove track"
          disabled={!canRemove}
          onClick={(e) => {
            e.stopPropagation()
            dispatch({ type: 'REMOVE_TRACK', trackId: track.id })
          }}
        >
          ×
        </button>
      </header>

      <div className="strip__row">
        <label className="field field--inline">
          <span className="label">In</span>
          <select className="readout" value={track.input} onChange={(e) => onInputChange(e.currentTarget)}>
            {INPUT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {track.input === 'mbus' && (
            <select
              className="readout"
              aria-label="mbus source"
              title="Record a sibling instrument published to the mbus patchbay (needs the local link-bridge)"
              value={mbusSourceId}
              onChange={(e) => controls.chooseMbusSource(track.id, e.currentTarget.value)}
            >
              <option value="">{mbusSources.length === 0 ? 'no sources…' : 'pick source'}</option>
              {mbusSources.map((src) => (
                <option key={src.sourceId} value={src.sourceId}>
                  {src.name} · {src.sourceId}
                </option>
              ))}
            </select>
          )}
        </label>
        <input
          ref={fileInputRef}
          className="sr-only"
          type="file"
          accept="audio/*"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0]
            if (file) void controls.importFile(track.id, file)
            e.currentTarget.value = '' // allow re-selecting the same file
          }}
        />
      </div>

      <div className="strip__buttons">
        <Toggle label="●" tone="record" pressed={track.armed} onToggle={() => patch({ armed: !track.armed })} title="Record-arm" />
        <Toggle label="M" pressed={track.mute} onToggle={() => patch({ mute: !track.mute })} title="Mute" />
        <Toggle label="S" tone="play" pressed={track.solo} onToggle={() => patch({ solo: !track.solo })} title="Solo" />
        <Toggle label="Mon" pressed={track.monitor} onToggle={() => patch({ monitor: !track.monitor })} title="Input monitor — can cause acoustic feedback" />
      </div>

      <div className="strip__mix">
        <Fader label="Vol" valueDb={track.gainDb} min={GAIN_DB_MIN} max={GAIN_DB_MAX} onChange={(gainDb) => patch({ gainDb })} />
        <Meter getLevel={level} label={`${track.name} level`} />
        <Knob label="Pan" value={track.pan} min={PAN_MIN} max={PAN_MAX} step={0.01} display={formatPan(track.pan)} onChange={(pan) => patch({ pan })} tone="cyan" />
      </div>

      <div className="strip__eq">
        <Knob label="Low" value={track.eq.lowDb} min={EQ_GAIN_DB_MIN} max={EQ_GAIN_DB_MAX} step={0.5} display={formatDbInt(track.eq.lowDb)} onChange={(lowDb) => patch({ eq: { ...track.eq, lowDb } })} />
        <Knob label="Mid" value={track.eq.midDb} min={EQ_GAIN_DB_MIN} max={EQ_GAIN_DB_MAX} step={0.5} display={formatDbInt(track.eq.midDb)} onChange={(midDb) => patch({ eq: { ...track.eq, midDb } })} />
        <Knob label="High" value={track.eq.highDb} min={EQ_GAIN_DB_MIN} max={EQ_GAIN_DB_MAX} step={0.5} display={formatDbInt(track.eq.highDb)} onChange={(highDb) => patch({ eq: { ...track.eq, highDb } })} />
      </div>

      <div className="strip__tape">
        <Toggle label="Tape" pressed={track.tape.enabled} onToggle={() => patch({ tape: { ...track.tape, enabled: !track.tape.enabled } })} title="Tape character" />
        <Knob label="Sat" value={track.tape.saturation} min={TAPE_AMOUNT_MIN} max={TAPE_AMOUNT_MAX} step={0.01} display={formatPct(track.tape.saturation)} onChange={(saturation) => patch({ tape: { ...track.tape, saturation } })} />
        <Knob label="W/F" value={track.tape.wowFlutter} min={TAPE_AMOUNT_MIN} max={TAPE_AMOUNT_MAX} step={0.01} display={formatPct(track.tape.wowFlutter)} onChange={(wowFlutter) => patch({ tape: { ...track.tape, wowFlutter } })} tone="cyan" />
      </div>
    </section>
  )
}
