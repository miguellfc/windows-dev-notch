import type { CodeReviewState, Platform, PlatformState } from '../../../shared/code-review/schema'
import type { GmailState } from '../../../shared/gmail/schema'
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

/** The unread-mail block of the compact capsule: the count it shows, or null when it takes no room. */
export interface MailLatch {
  /** 1–100 (100 shows as "99+"); null while there is no block. */
  unread: number | null
  /** Consecutive readings without unread mail while the block is shown. */
  missRun: number
}

export const EMPTY_MAIL: MailLatch = { unread: null, missRun: 0 }

/**
 * Folds one Gmail reading (`gmail:state`) into the mail block (pure; the store keeps the result).
 * Like the disk block: shown with the first reading that has unread mail in a live session (`ok`
 * or `offline`, which keeps the last data), given up only after CAPSULE_MISSES readings in a row
 * without, keeping the last count meanwhile, since it changes the capsule width. A session that
 * ends (signed out, expired, unconfigured, signing in again) hides it at once: no more readings
 * would arrive to release it.
 */
export function nextMail(previous: MailLatch, state: GmailState): MailLatch {
  const live = state.status === 'ok' || state.status === 'offline'
  if (!live) return EMPTY_MAIL
  if (state.unread !== null && state.unread > 0) return { unread: state.unread, missRun: 0 }
  if (previous.unread === null) return EMPTY_MAIL
  const missRun = previous.missRun + 1
  return missRun >= CAPSULE_MISSES ? EMPTY_MAIL : { unread: previous.unread, missRun }
}

/** One code-review block of the compact capsule (a platform's own unreviewed PR/MRs). */
export interface ReviewLatch {
  /** 1–100 (100 shows as "99+"); null while there is no block. */
  count: number | null
  /** Consecutive readings without unreviewed PR/MRs while the block is shown. */
  missRun: number
}

export type ReviewBlocks = Readonly<Record<Platform, ReviewLatch>>

const EMPTY_REVIEW: ReviewLatch = { count: null, missRun: 0 }
export const EMPTY_REVIEW_BLOCKS: ReviewBlocks = { github: EMPTY_REVIEW, gitlab: EMPTY_REVIEW }

/** The mail block's rule for one platform, except that a live 0 hides at once: live is `ok` or `offline` (which keeps the last data). */
function nextReview(previous: ReviewLatch, state: PlatformState): ReviewLatch {
  const live = state.status === 'ok' || state.status === 'offline'
  if (!live) return EMPTY_REVIEW
  if (state.unreviewed !== null && state.unreviewed > 0) {
    return previous.count === state.unreviewed && previous.missRun === 0 ? previous : { count: state.unreviewed, missRun: 0 }
  }
  // A live reading of 0 hides the block at once (it matches the "Aprobado" alert); only "no data" is latched.
  if (state.unreviewed === 0 || previous.count === null) return EMPTY_REVIEW
  const missRun = previous.missRun + 1
  return missRun >= CAPSULE_MISSES ? EMPTY_REVIEW : { count: previous.count, missRun }
}

/**
 * Folds one `code-review:state` reading into the per-platform blocks (pure): each platform is
 * latched like the mail block for "no data" readings only; a live 0 hides the block immediately.
 * Returns the same object when nothing changed.
 */
export function nextReviewBlocks(previous: ReviewBlocks, state: CodeReviewState): ReviewBlocks {
  const github = nextReview(previous.github, state.github)
  const gitlab = nextReview(previous.gitlab, state.gitlab)
  return github === previous.github && gitlab === previous.gitlab ? previous : { github, gitlab }
}

/** How many code-review blocks the capsule shows (each adds its measured width). */
export function reviewBlockCount(blocks: ReviewBlocks): number {
  return (blocks.github.count === null ? 0 : 1) + (blocks.gitlab.count === null ? 0 : 1)
}
