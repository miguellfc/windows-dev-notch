import type { RedmineState, RedmineSummary } from '../../../shared/redmine/schema'
import type { PinnedIssue } from './pin'
import { nextRedmineBlock, type RedmineLatch } from '../../notch/system/capsule-latch'

/** The part of the Redmine store a `redmine:state` reading changes. */
export interface RedmineSessionView {
  state: RedmineState | null
  block: RedmineLatch
  summary: RedmineSummary | null
  summaryError: boolean
  /** The issue pinned for quick access; session-only. */
  pinned: PinnedIssue | null
  /** An issue the shortcut asked the Redmine view to open; null once consumed. */
  openTarget: number | null
}

const isLive = (state: RedmineState | null): boolean => state !== null && (state.status === 'ok' || state.status === 'offline')

/**
 * Folds one `redmine:state` reading into the store (pure). The month summary, its error, the pinned issue and the open target belong to
 * the session: they are forgotten when it ends (not ok/offline) or another account takes over.
 */
export function nextRedmineSession(
  store: RedmineSessionView,
  state: RedmineState,
): Pick<RedmineSessionView, 'state' | 'block'> & Partial<Pick<RedmineSessionView, 'summary' | 'summaryError' | 'pinned' | 'openTarget'>> {
  const block = nextRedmineBlock(store.block, state)
  const ended = !isLive(state) || (isLive(store.state) && store.state?.account !== state.account)
  return ended ? { state, block, summary: null, summaryError: false, pinned: null, openTarget: null } : { state, block }
}
