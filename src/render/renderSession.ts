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
}

/** Read a source as mono at a fractional SOURCE-sample index. Multichannel
 *  sources are averaged so every track chain downstream is mono (matching the
 *  mono-track → pan → stereo model). */
function readSourceMono(src: RenderSource, index: number): number {
  const chs = src.channels
  const n = chs.length
  if (n === 0) return 0
  if (n === 1) return interpolateSample(chs[0], index)
  let sum = 0
  for (let c = 0; c < n; c++) sum += interpolateSample(chs[c], index)
  return sum / n
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
  const nFrames = Math.max(0, Math.round((endSec - startSec) * sampleRate))

  // Zero-length region ⇒ empty channels (still a valid, well-formed result).
  if (nFrames === 0) {
    const empty = Array.from({ length: channelCount }, () => new Float32Array(0))
    return { channels: empty, sampleRate, durationSec: 0 }
  }

  const busL = new Float32Array(nFrames)
  const busR = new Float32Array(nFrames)

  for (const track of audibleTracks(session.tracks)) {
    const buf = renderTrackDry(track, sources, opts, nFrames)

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
          const arrTime = startSec + f / sampleRate
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

  // 7. Varispeed: resample the final stereo mix. varispeed>1 ⇒ shorter + higher.
  let outL: Float32Array = busL
  let outR: Float32Array = busR
  const varispeed = session.master.varispeed
  if (varispeed !== 1) {
    outL = resampleChannel(busL, varispeed)
    outR = resampleChannel(busR, varispeed)
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
