import type { CodeReviewState, ContributionsResult, Platform, PlatformStatus } from '../../../shared/code-review/schema'
import type { GmailState } from '../../../shared/gmail/schema'
import type { RedmineState } from '../../../shared/redmine/schema'
import type { SystemMetrics } from '../../../shared/system/schema'

/** What the compact capsule shows: percentages only, battery slot or not, the storage block always. */
export interface CapsuleView {
  cpuPercent: number | null
  ramPercent: number | null
  battery: { percent: number; charging: boolean; pluggedIn: boolean } | null
  /** Which metrics are painted red. Colour only: never changes the width. */
  alerts: { cpu: boolean; ram: boolean; battery: boolean }
  /**
   * The whole computer's fill, always present while the view is. `lowDrive` is the latched letter of
   * the drive under the disk alert (null without one); while set the block is painted red, colour only.
   */
  storage: { usedPercent: number | null; lowDrive: string | null } | null
  /**
   * Internet reachability as main last read it (Windows' connectivity hint), not latched: an icon
   * of fixed width, so it may follow every sample. Null when Windows does not know; see `connectionOnline`.
   */
  online: boolean | null
}

export interface CapsuleLatch {
  /** Null shows time and date only. */
  view: CapsuleView | null
  /** Consecutive `unavailable` samples while a view is shown. */
  unavailableRun: number
  /** Consecutive samples without a battery while the battery slot is shown. */
  batteryMissRun: number
  /** Consecutive samples without a disk alert while the storage alert is held. */
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
  // The storage block is always there; only the disk alert (any drive) is latched like the battery
  // slot, so a single missed read does not make the red flap. A held alert keeps its drive letter.
  let lowDrive = metrics.alerts.disk?.letter ?? null
  let diskMissRun = 0
  const heldDrive = previous.view?.storage?.lowDrive ?? null
  if (lowDrive === null && heldDrive !== null) {
    diskMissRun = previous.diskMissRun + 1
    if (diskMissRun < CAPSULE_MISSES) lowDrive = heldDrive
    else diskMissRun = 0
  }
  const storage: CapsuleView['storage'] = { usedPercent: metrics.storage?.usedPercent ?? null, lowDrive }
  return {
    view: { cpuPercent: metrics.cpuPercent, ramPercent: ram, battery, alerts, storage, online: metrics.online },
    unavailableRun: 0,
    batteryMissRun,
    diskMissRun,
  }
}

/** The unread-mail block of the compact capsule: the count it shows, or null when it takes no room. */
export interface MailLatch {
  /** 0–100 (100 shows as "99+"); null while there is no block. */
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

/** One code-review block of the compact capsule: a platform's contributions this month. */
export interface ContributionLatch {
  /** The month's total (`ContributionSummary.monthTotal`), 0 included; null while there is no block. */
  total: number | null
  /** The total's month, `YYYY-MM` (the accessible label names it); null with no block. */
  month: string | null
  /** Consecutive readings without a month summary while the block is shown. */
  missRun: number
}

export type ContributionBlocks = Readonly<Record<Platform, ContributionLatch>>

const EMPTY_CONTRIBUTION: ContributionLatch = { total: null, month: null, missRun: 0 }
export const EMPTY_CONTRIBUTION_BLOCKS: ContributionBlocks = { github: EMPTY_CONTRIBUTION, gitlab: EMPTY_CONTRIBUTION }

/**
 * One platform's block: shown while the platform is live (`ok`, or `offline`, which keeps the last
 * data) with its month total, 0 included, so a connected platform turned on for the capsule always
 * shows once its first summary arrives. A reading without a summary ("no data": not answered yet,
 * or a session that just started again) keeps the last total until CAPSULE_MISSES in a row, like
 * the mail block; a failed query keeps its last summary in main, so it changes nothing. A platform
 * that stops being live (unconfigured, rejected token) hides it at once.
 */
function nextContribution(previous: ContributionLatch, status: PlatformStatus | undefined, result: ContributionsResult | undefined): ContributionLatch {
  const live = status === 'ok' || status === 'offline'
  if (!live) return EMPTY_CONTRIBUTION
  const summary = result?.summary ?? null
  if (summary !== null) {
    const unchanged = previous.total === summary.monthTotal && previous.month === summary.month && previous.missRun === 0
    return unchanged ? previous : { total: summary.monthTotal, month: summary.month, missRun: 0 }
  }
  if (previous.total === null) return EMPTY_CONTRIBUTION
  const missRun = previous.missRun + 1
  return missRun >= CAPSULE_MISSES ? EMPTY_CONTRIBUTION : { ...previous, missRun }
}

/**
 * Folds one reading (a `code-review:state`, or a platform's `code-review:contributions` answer)
 * into the per-platform blocks (pure). Returns the same object when nothing changed.
 */
export function nextContributionBlocks(
  previous: ContributionBlocks,
  state: CodeReviewState | null,
  contributions: Partial<Record<Platform, ContributionsResult>>,
): ContributionBlocks {
  const github = nextContribution(previous.github, state?.github.status, contributions.github)
  const gitlab = nextContribution(previous.gitlab, state?.gitlab.status, contributions.gitlab)
  return github === previous.github && gitlab === previous.gitlab ? previous : { github, gitlab }
}

/** How many code-review blocks the capsule shows (each adds its measured width). */
export function contributionBlockCount(blocks: ContributionBlocks): 0 | 1 | 2 {
  return ((blocks.github.total === null ? 0 : 1) + (blocks.gitlab.total === null ? 0 : 1)) as 0 | 1 | 2
}

/** The Redmine block of the compact capsule: the hours logged this month it shows, or null when it takes no room. */
export interface RedmineLatch {
  /** Hours logged from the 1st of the month to today, 0 included; null while there is no block. */
  hours: number | null
  /** Consecutive readings without the month's hours while the block is shown. */
  missRun: number
}

export const EMPTY_REDMINE: RedmineLatch = { hours: null, missRun: 0 }

/**
 * Folds one `redmine:state` reading into the Redmine block (pure; returns the same object when
 * nothing changed). Shown with the first reading that has the month's hours in a live session (`ok`
 * or `offline`, which keeps the last data), a 0 included: "0h" is what tells the user nothing is
 * logged yet this month. A reading without them keeps the last value until CAPSULE_MISSES in a row,
 * since the block changes the capsule width. A session that ends (unconfigured, signed out) hides it
 * at once, and so does `offline` without hours: main drops the last reading once its month is over,
 * and last month's hours must never pass for this month's.
 */
export function nextRedmineBlock(previous: RedmineLatch, state: RedmineState): RedmineLatch {
  const live = state.status === 'ok' || state.status === 'offline'
  if (!live) return EMPTY_REDMINE
  if (state.monthHours !== null) return previous.hours === state.monthHours && previous.missRun === 0 ? previous : { hours: state.monthHours, missRun: 0 }
  if (previous.hours === null || state.status === 'offline') return EMPTY_REDMINE
  const missRun = previous.missRun + 1
  return missRun >= CAPSULE_MISSES ? EMPTY_REDMINE : { hours: previous.hours, missRun }
}
