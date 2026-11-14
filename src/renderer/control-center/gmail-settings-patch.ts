import type { Settings } from '../../shared/settings/schema'
import { createBlockUpdater } from './settings-block-patch'

export type GmailSettings = Settings['gmail']

/** Serialized patches of the gmail block (see `createBlockUpdater`). */
export function createGmailUpdater<R>(getLatest: () => GmailSettings, update: (patch: { gmail: GmailSettings }) => Promise<R>) {
  return createBlockUpdater('gmail', getLatest, update)
}
