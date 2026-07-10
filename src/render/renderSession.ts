// mtape — pure offline mixdown. This is the REFERENCE engine: the live worklet is
// validated against it, so it must compose the shared DSP primitives (never
// reinvent them) and be byte-for-byte deterministic. PURE: no DOM, no Web Audio,
// no clock, no randomness — output is a function of (session, sources, opts) only.

import type { Session, Track } from '../audio/contracts'
import { dbToLin, panGains, trackGainLin } from '../audio/dsp/gain'
import { BrickwallLimiter, softClipDrive } from '../audio/dsp/dynamics'
import { interpolateSample, softSaturate, wowFlutterOffset } from '../audio/dsp/tape'
import { ThreeBandEqProcessor } from '../audio/dsp/eq'
import { clipEndSec, fadeGainAt } from '../clips/clipMath'

/** Decoded source audio, keyed in a SourceMap by a clip's `audioId`. */
export interface RenderSource {
  channels: Float32Array[]
  sampleRate: number
}

export type SourceMap = Map<string, RenderSource>

export interface RenderResult {
  channels: Float32Array[]
  sampleRate: number
  durationSec: number
}

export interface RenderOptions {
  sampleRate: number
  startSec: number
  endSec: number
  channels?: 1 | 2
  /** Test-only override for the region warm-up preroll (seconds). Defaults to
   *  WARMUP_SEC; callers never need to set it. */
  warmupSec?: number
}

/**
 * Region warm-up preroll. A render with startSec>0 builds a FRESH EQ + limiter
 * and would otherwise start cold, whereas live playback reaches startSec with
 * warm filter/gain history. We process this many seconds of the REAL earlier
 * signal ahead of the region and slice it off, so EQ transients have settled and
 * the limiter's release gain matches by the time the requested region begins.
 * 0.5s comfortably exceeds the limiter's default 50 ms release plus biquad
 * settling (a few ms at audio rates); the equivalence test validates sufficiency.
 */
const WARMUP_SEC = 0.5

/** Read a source as mono at a fractional SOURCE-sample index. Multichannel
 *  sources are averaged so every track chain downstream is mono (matching the
 *  mono-track → pan → stereo model). */
function readSourceMono(src: RenderSource, index: number): number {
  const chs = src.channels
  const n = chs.length
  if (n === 0) return 0
  // Past either end of the recorded material there is nothing to play.
  // interpolateSample would clamp to the edge sample (an audible DC hold), so a
  // clip trimmed past its source must read as silence — the live worklet shares
  // this law so the two stay equivalent. (L6)
  if (index < 0 || index >= chs[0].length) return 0
  let s: number
  if (n === 1) s = interpolateSample(chs[0], index)
  else {
    let sum = 0
    for (let c = 0; c < n; c++) sum += interpolateSample(chs[c], index)
    s = sum / n
  }
  return Number.isFinite(s) ? s : 0 // a corrupt source sample must not poison persistent EQ/limiter state
}

/**
 * Resolve which tracks are audible. If ANY track is soloed, only soloed tracks
 * that are not muted play; otherwise every non-muted track plays. (A soloed+muted
 * track is silent — mute wins within the solo set.)
 */
function audibleTracks(tracks: Track[]): Track[] {
  const anySolo = tracks.some((t) => t.solo)
  if (anySolo) return tracks.filter((t) => t.solo && !t.mute)
  return tracks.filter((t) => !t.mute)
}

/**
 * Build a mono dry buffer for one track over the render region. Each clip is
 * summed in (overlaps add). The arrangement→source mapping uses the SOURCE
 * sample rate to form the fractional index, so a source at a different rate
 * resamples correctly. A clip whose audioId is absent from `sources` is silent.
 */
function renderTrackDry(track: Track, sources: SourceMap, opts: RenderOptions, nFrames: number): Float32Array {
  const { sampleRate, startSec } = opts
  const dry = new Float32Array(nFrames)

  for (const clip of track.clips) {
    const src = sources.get(clip.audioId)
    if (!src) continue // missing backing audio => silent, never throws

    const clipStart = clip.startSec
    const clipEnd = clipEndSec(clip)
    // Half-open [clipStart, clipEnd): first/last output frames overlapping it.
    const first = Math.max(0, Math.ceil((clipStart - startSec) * sampleRate))
    const lastExcl = Math.min(nFrames, Math.ceil((clipEnd - startSec) * sampleRate))
    if (lastExcl <= first) continue

    const clipLin = dbToLin(clip.gainDb)
    for (let f = first; f < lastExcl; f++) {
      const arrTime = startSec + f / sampleRate
      const clipLocal = arrTime - clipStart
      const sourceTime = clip.offsetSec + clipLocal
      const srcIndex = sourceTime * src.sampleRate
      const g = clipLin * fadeGainAt(clip, clipLocal)
      if (g !== 0) dry[f] += readSourceMono(src, srcIndex) * g
    }
  }
  return dry
}

/**
 * Resample a single channel by `readStride` source-frames per output-frame using
 * linear interpolation. readStride = varispeed (>1 ⇒ shorter output, higher pitch).
 */
function resampleChannel(input: Float32Array, readStride: number): Float32Array {
  const outLen = Math.max(0, Math.round(input.length / readStride))
  const out = new Float32Array(outLen)
  for (let j = 0; j < outLen; j++) out[j] = interpolateSample(input, j * readStride)
  return out
}

/**
 * Offline reference mixdown. Signal flow mirrors the live per-track chain so
 * offline == live: dry clip render → per-track EQ → per-track tape → gain/pan
 * into a stereo bus → master gain/drive/limiter → varispeed → optional mono
 * downmix. Deterministic for identical inputs.
 */
export function renderSession(session: Session, sources: SourceMap, opts: RenderOptions): RenderResult {
  const { sampleRate, startSec, endSec } = opts
  const channelCount = opts.channels ?? 2
  // Frames the CALLER asked for (the requested region), which also drives the
  // zero-length guard — the warm-up preroll below is internal and invisible.
  const outFrames = Math.max(0, Math.round((endSec - startSec) * sampleRate))

  // Zero-length region ⇒ empty channels (still a valid, well-formed result).
  if (outFrames === 0) {
    const empty = Array.from({ length: channelCount }, () => new Float32Array(0))
    return { channels: empty, sampleRate, durationSec: 0 }
  }

  // Warm the EQ + limiter through a preroll of real earlier signal so a region
  // render (startSec>0) matches live/full-render. preFrames is an integer so the
  // warmed sample grid stays frame-aligned with a full render; startSec=0 ⇒
  // preFrames=0 ⇒ byte-identical to a no-warmup render.
  const warmupSec = opts.warmupSec ?? WARMUP_SEC
  const preFrames = Math.min(Math.max(0, Math.round(startSec * sampleRate)), Math.max(0, Math.round(warmupSec * sampleRate)))
  const renderStart = startSec - preFrames / sampleRate
  const nFrames = outFrames + preFrames // total frames processed, incl. preroll
  // Internal opts whose startSec is the earlier (warmed) origin; every arrTime
  // downstream is derived from renderStart so the preroll reads real material.
  const renderOpts: RenderOptions = { ...opts, startSec: renderStart }

  const busL = new Float32Array(nFrames)
  const busR = new Float32Array(nFrames)

  for (const track of audibleTracks(session.tracks)) {
    const buf = renderTrackDry(track, sources, renderOpts, nFrames)

    // 3. Per-track EQ — flat bands (0 dB) are an exact passthrough.
    const eq = new ThreeBandEqProcessor(track.eq, sampleRate)
    for (let f = 0; f < nFrames; f++) buf[f] = eq.process(buf[f])

    // 4. Per-track tape colour (default-off; only when enabled).
    if (track.tape.enabled) {
      const sat = track.tape.saturation
      if (sat > 0) {
        for (let f = 0; f < nFrames; f++) buf[f] = softSaturate(buf[f], sat)
      }
      const wf = track.tape.wowFlutter
      if (wf > 0) {
        // Modulated delay read on the (already-saturated) buffer. Absolute time
        // drives the LFOs so the wander is deterministic and phase-stable.
        const sat2 = buf.slice()
        for (let f = 0; f < nFrames; f++) {
          const arrTime = renderStart + f / sampleRate
          const offsetSamples = wowFlutterOffset(arrTime, wf) * sampleRate
          buf[f] = interpolateSample(sat2, f - offsetSamples)
        }
      }
    }

    // 5. Track → stereo master: fader gain then equal-power pan, accumulated.
    const g = trackGainLin(track.gainDb)
    const pan = panGains(track.pan)
    const gl = g * pan.left
    const gr = g * pan.right
    for (let f = 0; f < nFrames; f++) {
      busL[f] += buf[f] * gl
      busR[f] += buf[f] * gr
    }
  }

  // 6. Master chain on the summed stereo bus.
  const masterLin = dbToLin(session.master.gainDb)
  const drive = session.master.drive
  const limL = new BrickwallLimiter({ ceilingDb: session.master.limiterCeilingDb, sampleRate })
  const limR = new BrickwallLimiter({ ceilingDb: session.master.limiterCeilingDb, sampleRate })
  for (let f = 0; f < nFrames; f++) {
    let l = busL[f] * masterLin
    let r = busR[f] * masterLin
    if (drive !== 0) {
      l = softClipDrive(l, drive)
      r = softClipDrive(r, drive)
    }
    busL[f] = limL.process(l)
    busR[f] = limR.process(r)
  }

  // 6b. Drop the warm-up preroll now that EQ + limiter are warm, BEFORE varispeed
  // and downmix, so timing and output length match the requested region exactly.
  // preFrames=0 (startSec=0) leaves busL/busR untouched — byte-compat guard.
  const warmL = preFrames > 0 ? busL.subarray(preFrames) : busL
  const warmR = preFrames > 0 ? busR.subarray(preFrames) : busR

  // 7. Varispeed: resample the final stereo mix. varispeed>1 ⇒ shorter + higher.
  let outL: Float32Array = warmL
  let outR: Float32Array = warmR
  const varispeed = session.master.varispeed
  if (varispeed !== 1) {
    outL = resampleChannel(warmL, varispeed)
    outR = resampleChannel(warmR, varispeed)
  }

  // 8. Optional stereo → mono downmix at the very end.
  let channels: Float32Array[]
  if (channelCount === 1) {
    const mono = new Float32Array(outL.length)
    for (let f = 0; f < mono.length; f++) mono[f] = (outL[f] + outR[f]) / 2
    channels = [mono]
  } else {
    channels = [outL, outR]
  }

  return { channels, sampleRate, durationSec: channels[0].length / sampleRate }
}
