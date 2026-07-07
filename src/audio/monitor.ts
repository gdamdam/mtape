/**
 * Input-monitor helpers — the pure half of the MON toggle.
 *
 * Monitoring is a main-thread concern: each attached input already has a
 * per-track `source → monitorGain → destination` leg (see AudioEngine), and
 * these helpers decide which of those gains are open. The monitor leg carries
 * the RAW input — it bypasses the worklet, so it is not part of the mix the
 * master publishes or renders; it exists so you can hear what you're about to
 * record. Unknown tracks fall back to 0 (feedback safety).
 */

/** The structural slice of an InputHandle the gain update needs. */
export interface MonitorHandle {
  monitor: { gain: { value: number } }
}

/** Track ids whose arrangement entry has monitor on. */
export function monitoredTrackIds(tracks: ReadonlyArray<{ trackId: string; monitor: boolean }>): Set<string> {
  const on = new Set<string>()
  for (const t of tracks) if (t.monitor) on.add(t.trackId)
  return on
}

/** Open the monitor gain of attached inputs in `monitorOn`; close all others. */
export function applyMonitorGains(inputs: ReadonlyMap<string, MonitorHandle>, monitorOn: ReadonlySet<string>): void {
  for (const [trackId, handle] of inputs) {
    handle.monitor.gain.value = monitorOn.has(trackId) ? 1 : 0
  }
}
