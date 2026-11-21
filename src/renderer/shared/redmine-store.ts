import { create } from 'zustand'
import type { RedmineAlert, RedmineState, RedmineSummary } from '../../shared/redmine/schema'
import { EMPTY_REDMINE, type RedmineLatch } from '../notch/system/capsule-latch'
import { nextRedmineSession } from './redmine/session'

interface RedmineStoreState {
  /** Status, account and today's hours from main; null until the first reading. Never the API key. */
  state: RedmineState | null
  /** The capsule's hours block, latched so one reading without hours keeps the width. */
  block: RedmineLatch
  /** The last end-of-day alert from main, what the alert capsule shows; null once spent. */
  alert: RedmineAlert | null
  /** Main says the alert capsule shows the end-of-day alert (`notch:redmine-alert`). */
  redmineAlert: boolean
  /** The last month summary main answered (kept across openings, forgotten when the session ends or the account changes); null until one arrives. */
  summary: RedmineSummary | null
  /** Whether the last summary query failed; the view shows its retry line. */
  summaryError: boolean
  /** The view has something under the search box: the capsule takes its taller size. */
  searching: boolean
  /** The view's own height at rest with the summary and the box (the capsule fits it); null: the full rest size. */
  viewHeight: number | null
}

export const useRedmine = create<RedmineStoreState>(() => ({
  state: null,
  block: EMPTY_REDMINE,
  alert: null,
  redmineAlert: false,
  summary: null,
  summaryError: false,
  searching: false,
  viewHeight: null,
}))

let summaryRequest = 0

const apply = (state: RedmineState) => {
  const next = nextRedmineSession(useRedmine.getState(), state)
  // A summary request of the session that just ended must not bring its answer back.
  if ('summary' in next) summaryRequest++
  useRedmine.setState(next)
}

/** Remembers (or forgets) the alert payload; the capsule shows it while main's mode is `alert`. */
export const setRedmineAlertPayload = (alert: RedmineAlert | null): void => useRedmine.setState({ alert })

/** Whether main's pending alert is the end-of-day alert (`notch:redmine-alert`). */
export const setRedmineAlert = (redmineAlert: boolean): void => useRedmine.setState({ redmineAlert })

/** Whether the Redmine view needs the capsule's taller size. */
export const setRedmineSearching = (searching: boolean): void => useRedmine.setState({ searching })

/** The Redmine view reports its content height at rest (null: it fills the full panel). */
export const setRedmineViewHeight = (viewHeight: number | null): void => useRedmine.setState({ viewHeight })

/**
 * Asks main for the cached month summary and keeps the answer. An answer that arrives after a newer
 * request is dropped, so a slow reply never overwrites a fresher one. A failed query keeps the last
 * summary and raises `summaryError`.
 */
export async function loadSummary(): Promise<void> {
  const request = ++summaryRequest
  const result = await window.notch.redmine.summary()
  if (!result.ok || summaryRequest !== request) return
  const { summary, error } = result.data
  useRedmine.setState((store) => ({ summary: summary ?? store.summary, summaryError: error }))
}

/** Keeps the store in sync with the main process; subscribe first so an early read never wins. */
export function bindRedmine(): void {
  let pushed = false
  window.notch.events.on('redmine:state', (state) => {
    pushed = true
    apply(state)
  })
  void window.notch.redmine.getState().then((result) => {
    if (result.ok && !pushed) apply(result.data)
  })
}
