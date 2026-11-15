/**
 * A settings patch replaces a whole top-level block, and the store only reflects a change after its
 * IPC round trip. Chaining the updates and reading the latest block inside the chain keeps two quick
 * changes from building the second patch on stale data.
 */
export function createBlockUpdater<K extends string, B, R>(key: K, getLatest: () => B, update: (patch: Record<K, B>) => Promise<R>) {
  let chain: Promise<unknown> = Promise.resolve()
  return (change: (latest: B) => B): Promise<R> => {
    const run = chain.then(() => update({ [key]: change(getLatest()) } as Record<K, B>))
    chain = run.catch(() => undefined)
    return run
  }
}
