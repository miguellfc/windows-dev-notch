import { create } from 'zustand'
import type { CodeReviewAlert, CodeReviewState, ContributionsResult, Platform } from '../../shared/code-review/schema'
import { EMPTY_CONTRIBUTION_BLOCKS, nextContributionBlocks, type ContributionBlocks } from '../notch/system/capsule-latch'
import { PLATFORMS } from './code-review/format'

/** Where the reviews view opens: the platform the alert or tile stands for. */
export interface ReviewsTarget {
  platform: Platform
}

interface CodeReviewStoreState {
  /** Status, account and unreviewed counts from main; null until the first reading. Never tokens. */
  state: CodeReviewState | null
  /** The capsule's per-platform blocks (the month's contributions), latched so one reading without a summary keeps the width. */
  blocks: ContributionBlocks
  /** The last first-review alert from main, what the alert capsule shows; null once spent. */
  alert: CodeReviewAlert | null
  /** Main says the alert capsule shows the first-review alert (`notch:review-alert`). */
  reviewAlert: boolean
  /** Set by the alert's click: the view opens on this platform, then forgets it. */
  target: ReviewsTarget | null
  /** The last `code-review:contributions` answer per platform (kept across openings); never repositories or titles. */
  contributions: Partial<Record<Platform, ContributionsResult>>
  /** The reviews view's own height while it shows contributions (the capsule fits it); null: the full panel. */
  viewHeight: number | null
}

export const useCodeReview = create<CodeReviewStoreState>(() => ({
  state: null,
  blocks: EMPTY_CONTRIBUTION_BLOCKS,
  alert: null,
  reviewAlert: false,
  target: null,
  contributions: {},
  viewHeight: null,
}))

/** Whether this renderer asks for the contributions of live platforms itself (the notch: the channel is its own). */
let loadsLiveContributions = false

/**
 * A live platform (`ok`/`offline`) whose contributions were never asked for in this renderer asks
 * now: the capsule shows the month's total, and main's own `code-review:contributions-changed` may
 * have gone out before the notch subscribed (startup). Later changes come with that event.
 */
function loadLive(state: CodeReviewState): void {
  if (!loadsLiveContributions) return
  for (const platform of PLATFORMS) {
    const { status } = state[platform]
    if ((status === 'ok' || status === 'offline') && contributionRequests[platform] === undefined) void loadContributions(platform)
  }
}

const apply = (state: CodeReviewState) => {
  useCodeReview.setState((store) => ({ state, blocks: nextContributionBlocks(store.blocks, state, store.contributions) }))
  loadLive(state)
}

/** Remembers (or forgets) the alert payload; the capsule shows it while main's mode is `alert`. */
export const setReviewAlertPayload = (alert: CodeReviewAlert | null): void => useCodeReview.setState({ alert })

/** Whether main's pending alert is the first-review alert (`notch:review-alert`). */
export const setReviewAlert = (reviewAlert: boolean): void => useCodeReview.setState({ reviewAlert })

/** Where the next opening of the reviews view lands (null: the first configured platform, no row focused). */
export const setReviewsTarget = (target: ReviewsTarget | null): void => useCodeReview.setState({ target })

/** The reviews view reports its content height (null: it fills the full panel). */
export const setReviewsViewHeight = (viewHeight: number | null): void => useCodeReview.setState({ viewHeight })

/**
 * Asks main for one platform's contributions and keeps the answer. An answer that arrives after a
 * newer request for the same platform is dropped, so a slow reply never overwrites a fresher one.
 */
const contributionRequests: Partial<Record<Platform, number>> = {}
export async function loadContributions(platform: Platform): Promise<void> {
  const request = (contributionRequests[platform] ?? 0) + 1
  contributionRequests[platform] = request
  const result = await window.notch.codeReview.contributions({ platform })
  if (!result.ok || contributionRequests[platform] !== request) return
  useCodeReview.setState((store) => {
    const contributions = { ...store.contributions, [platform]: result.data }
    return { contributions, blocks: nextContributionBlocks(store.blocks, store.state, contributions) }
  })
}

/** Keeps the store in sync with the main process; subscribe first so an early read never wins. */
export function bindCodeReview(): void {
  let pushed = false
  window.notch.events.on('code-review:state', (state) => {
    pushed = true
    apply(state)
  })
  void window.notch.codeReview.getState().then((result) => {
    if (result.ok && !pushed) apply(result.data)
  })
  // Every change (new data, failure, cleared cache) asks for that platform again, view open or not.
  window.notch.events.on('code-review:contributions-changed', ({ platform }) => void loadContributions(platform))
}

/**
 * The notch only (`code-review:contributions` is its channel): every platform that turns live gets
 * its contributions read once, for the capsule's month total; including one live already.
 */
export function bindCodeReviewContributions(): void {
  loadsLiveContributions = true
  const { state } = useCodeReview.getState()
  if (state) loadLive(state)
}
