import type { Settings } from '../../shared/settings/schema'

export type GmailSettings = Settings['gmail']

/**
 * The settings patch replaces the whole gmail block, and the store only reflects a change after
 * its IPC round trip. Chaining the updates and reading the latest block inside the chain keeps two
 * quick changes from building the second patch on stale data.
 */
export function createGmailUpdater<R>(getLatest: () => GmailSettings, update: (patch: { gmail: GmailSettings }) => Promise<R>) {
  let chain: Promise<unknown> = Promise.resolve()
  return (change: (latest: GmailSettings) => GmailSettings): Promise<R> => {
    const run = chain.then(() => update({ gmail: change(getLatest()) }))
    chain = run.catch(() => undefined)
    return run
  }
}
