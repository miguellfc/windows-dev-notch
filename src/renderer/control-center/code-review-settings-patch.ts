import type { Settings } from '../../shared/settings/schema'
import { createBlockUpdater } from './settings-block-patch'

export type CodeReviewSettings = Settings['codeReview']
export type CodeReviewAlerts = CodeReviewSettings['alerts']

/**
 * Serialized patches of the alerts only (see `createBlockUpdater`): main merges the patch into the
 * codeReview block, so a URL it saved moments ago is never put back.
 */
export function createCodeReviewUpdater<R>(
  getLatest: () => CodeReviewSettings,
  update: (patch: { codeReview: { alerts: CodeReviewAlerts } }) => Promise<R>,
) {
  return createBlockUpdater('codeReview', () => ({ alerts: getLatest().alerts }), update)
}
