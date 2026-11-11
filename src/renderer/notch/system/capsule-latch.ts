import type { SystemMetrics } from '../../../shared/system/schema'

/** What the compact capsule shows: percentages only, battery slot or not. */
export interface CapsuleView {
  cpuPercent: number | null
  ramPercent: number | null
  battery: { percent: number; charging: boolean; pluggedIn: boolean } | null
}

export interface CapsuleLatch {
  /** Null shows time and date only. */
  view: CapsuleView | null
  /** Consecutive `unavailable` samples while a view is shown. */
  unavailableRun: number
  /** Consecutive samples without a battery while the battery slot is shown. */
  batteryMissRun: number
}

/**
 * Consecutive misses before the capsule gives up a slot. Every change of slot re-runs the width
 * morph and the content cross-fade, so one failed read (a power API hiccup, an unknown percent)
 * must not make the capsule flap between widths.
 */
export const CAPSULE_MISSES = 3

export const EMPTY_CAPSULE: CapsuleLatch = { view: null, unavailableRun: 0, batteryMissRun: 0 }

/** Folds one sample into the capsule latch (pure; the store keeps the result). */
export function nextCapsule(previous: CapsuleLatch, metrics: SystemMetrics): CapsuleLatch {
  if (metrics.kind === 'unavailable') {
    if (!previous.view) return EMPTY_CAPSULE
    const unavailableRun = previous.unavailableRun + 1
    // Below the limit the last values stay: they are at most a couple of samples old.
    return unavailableRun >= CAPSULE_MISSES ? EMPTY_CAPSULE : { ...previous, unavailableRun }
  }

  const ram = metrics.ram && metrics.ram.totalBytes > 0 ? (metrics.ram.usedBytes / metrics.ram.totalBytes) * 100 : null
  let battery: CapsuleView['battery'] = null
  let batteryMissRun = 0
  if (metrics.battery) {
    battery = { percent: metrics.battery.percent, charging: metrics.battery.charging, pluggedIn: metrics.battery.pluggedIn }
  } else if (previous.view?.battery) {
    batteryMissRun = previous.batteryMissRun + 1
    // Keep the last value until the battery has been missing CAPSULE_MISSES times in a row.
    if (batteryMissRun < CAPSULE_MISSES) battery = previous.view.battery
    else batteryMissRun = 0
  }
  return { view: { cpuPercent: metrics.cpuPercent, ramPercent: ram, battery }, unavailableRun: 0, batteryMissRun }
}
