import { create } from 'zustand'
import type { CodeReviewAlert, CodeReviewState, ContributionsResult, Platform } from '../../shared/code-review/schema'
import { EMPTY_REVIEW_BLOCKS, nextReviewBlocks, type ReviewBlocks } from '../notch/system/capsule-latch'
import type { ReviewSection } from './code-review/format'

/** Where the reviews view opens: a platform's tab and the section to land on. */
export interface ReviewsTarget {
  platform: Platform
  section: ReviewSection
}

interface CodeReviewStoreState {
  /** Status, account and unreviewed counts from main; null until the first reading. Never tokens. */
  state: CodeReviewState | null
  /** The capsule's per-platform blocks, latched so one reading without a count keeps the width. */
  blocks: ReviewBlocks
  /** The last first-review alert from main, what the alert capsule shows; null once spent. */
  alert: CodeReviewAlert | null
  /** Main says the alert capsule shows the first-review alert (`notch:review-alert`). */
  reviewAlert: boolean
  /** Set by the alert's click: the view opens on this platform and section, then forgets it. */
  target: ReviewsTarget | null
  /** The last `code-review:contributions` answer per platform (kept across openings); never repositories or titles. */
  contributions: Partial<Record<Platform, ContributionsResult>>
}

export const useCodeReview = create<CodeReviewStoreState>(() => ({
  state: null,
  blocks: EMPTY_REVIEW_BLOCKS,
  alert: null,
  reviewAlert: false,
  target: null,
  contributions: {},
}))

const apply = (state: CodeReviewState) => useCodeReview.setState((store) => ({ state, blocks: nextReviewBlocks(store.blocks, state) }))

/** Remembers (or forgets) the alert payload; the capsule shows it while main's mode is `alert`. */
export const setReviewAlertPayload = (alert: CodeReviewAlert | null): void => useCodeReview.setState({ alert })

/** Whether main's pending alert is the first-review alert (`notch:review-alert`). */
export const setReviewAlert = (reviewAlert: boolean): void => useCodeReview.setState({ reviewAlert })

/** Where the next opening of the reviews view lands (null: the first configured platform, its first row). */
export const setReviewsTarget = (target: ReviewsTarget | null): void => useCodeReview.setState({ target })

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
  useCodeReview.setState((store) => ({ contributions: { ...store.contributions, [platform]: result.data } }))
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
}
