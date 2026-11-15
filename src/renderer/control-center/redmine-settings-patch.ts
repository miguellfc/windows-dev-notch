import type { Settings } from '../../shared/settings/schema'
import { createBlockUpdater } from './settings-block-patch'

export type RedmineSettings = Settings['redmine']
/** What this page patches: everything but the URL, which main writes itself when the key is saved. */
export type RedminePatch = Pick<RedmineSettings, 'dailyTargetHours' | 'endOfDay'>

/**
 * Serialized patches of the target and the end-of-day alert (see `createBlockUpdater`): main merges
 * the patch into the redmine block, so a URL it saved moments ago is never put back.
 */
export function createRedmineUpdater<R>(getLatest: () => RedmineSettings, update: (patch: { redmine: RedminePatch }) => Promise<R>) {
  return createBlockUpdater(
    'redmine',
    (): RedminePatch => {
      const { dailyTargetHours, endOfDay } = getLatest()
      return { dailyTargetHours, endOfDay }
    },
    update,
  )
}
