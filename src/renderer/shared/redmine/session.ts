import type { RedmineState, RedmineSummary } from '../../../shared/redmine/schema'
import { nextRedmineBlock, type RedmineLatch } from '../../notch/system/capsule-latch'

/** The part of the Redmine store a `redmine:state` reading changes. */
export interface RedmineSessionView {
  state: RedmineState | null
  block: RedmineLatch
  summary: RedmineSummary | null
  summaryError: boolean
}

const isLive = (state: RedmineState | null): boolean => state !== null && (state.status === 'ok' || state.status === 'offline')

/**
 * Folds one `redmine:state` reading into the store (pure). The month summary and its error belong to
 * the session: they are forgotten when it ends (not ok/offline) or another account takes over.
 */
export function nextRedmineSession(
  store: RedmineSessionView,
  state: RedmineState,
): Pick<RedmineSessionView, 'state' | 'block'> & Partial<Pick<RedmineSessionView, 'summary' | 'summaryError'>> {
  const block = nextRedmineBlock(store.block, state)
  const ended = !isLive(state) || (isLive(store.state) && store.state?.account !== state.account)
  return ended ? { state, block, summary: null, summaryError: false } : { state, block }
}
