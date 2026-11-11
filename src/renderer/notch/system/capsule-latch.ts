import type { SystemMetrics } from '../../../shared/system/schema'

/** What the compact capsule shows: percentages only, battery slot or not, low-disk block or not. */
export interface CapsuleView {
  cpuPercent: number | null
  ramPercent: number | null
  battery: { percent: number; charging: boolean; pluggedIn: boolean } | null
  /** Which metrics are painted red. Colour only: never changes the width. */
  alerts: { cpu: boolean; ram: boolean; battery: boolean }
  /** The worst fixed drive below its free-space threshold; the block exists only while set. */
  disk: { letter: string; freePercent: number } | null
}

export interface CapsuleLatch {
  /** Null shows time and date only. */
  view: CapsuleView | null
  /** Consecutive `unavailable` samples while a view is shown. */
  unavailableRun: number
  /** Consecutive samples without a battery while the battery slot is shown. */
  batteryMissRun: number
  /** Consecutive samples without a disk alert while the disk block is shown. */
  diskMissRun: number
}

/**
 * Consecutive misses before the capsule gives up a slot. Every change of slot re-runs the width
 * morph and the content cross-fade, so one failed read (a power API hiccup, an unknown percent)
 * must not make the capsule flap between widths.
 */
export const CAPSULE_MISSES = 3

export const EMPTY_CAPSULE: CapsuleLatch = { view: null, unavailableRun: 0, batteryMissRun: 0, diskMissRun: 0 }

/** Folds one sample into the capsule latch (pure; the store keeps the result). */
export function nextCapsule(previous: CapsuleLatch, metrics: SystemMetrics): CapsuleLatch {
  if (metrics.kind === 'unavailable') {
    if (!previous.view) return EMPTY_CAPSULE
    const unavailableRun = previous.unavailableRun + 1
    // Below the limit the last values stay: they are at most a couple of samples old.
    return unavailableRun >= CAPSULE_MISSES ? EMPTY_CAPSULE : { ...previous, unavailableRun }
  }

  const ram = metrics.ram && metrics.ram.totalBytes > 0 ? (metrics.ram.usedBytes / metrics.ram.totalBytes) * 100 : null
  const alerts = { cpu: metrics.alerts.cpu, ram: metrics.alerts.ram, battery: metrics.alerts.battery }
  let battery: CapsuleView['battery'] = null
  let batteryMissRun = 0
  if (metrics.battery) {
    battery = { percent: metrics.battery.percent, charging: metrics.battery.charging, pluggedIn: metrics.battery.pluggedIn }
  } else if (previous.view?.battery) {
    batteryMissRun = previous.batteryMissRun + 1
    // Keep the last value until the battery has been missing CAPSULE_MISSES times in a row; a held
    // value keeps its colour too (with no battery the sample's battery alert is always false).
    if (batteryMissRun < CAPSULE_MISSES) {
      battery = previous.view.battery
      alerts.battery = previous.view.alerts.battery
    } else batteryMissRun = 0
  }
  // The disk block follows the same rule: shown with the first low-disk sample, given up only after
  // CAPSULE_MISSES samples in a row without one, since it changes the capsule width.
  let disk: CapsuleView['disk'] = null
  let diskMissRun = 0
  if (metrics.alerts.disk) {
    disk = { letter: metrics.alerts.disk.letter, freePercent: metrics.alerts.disk.freePercent }
  } else if (previous.view?.disk) {
    diskMissRun = previous.diskMissRun + 1
    if (diskMissRun < CAPSULE_MISSES) disk = previous.view.disk
    else diskMissRun = 0
  }
  return {
    view: { cpuPercent: metrics.cpuPercent, ramPercent: ram, battery, alerts, disk },
    unavailableRun: 0,
    batteryMissRun,
    diskMissRun,
  }
}
