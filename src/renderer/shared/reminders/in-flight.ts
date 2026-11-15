/**
 * Tracks which reminder ids have an action call in flight, so a row cannot act twice at once.
 * Plain TypeScript (no React) so it is unit-testable; `useInFlight` wraps it for components.
 */
export interface InFlightGuard {
  has(id: string): boolean
  /**
   * Runs `call` unless one is already running for `id` (then resolves `undefined` without calling).
   * The id is released when the call settles, success or failure.
   */
  run<T>(id: string, call: () => Promise<T>): Promise<T | undefined>
}

export function createInFlightGuard(onChange: () => void): InFlightGuard {
  const ids = new Set<string>()
  return {
    has: (id) => ids.has(id),
    async run(id, call) {
      if (ids.has(id)) return undefined
      ids.add(id)
      onChange()
      try {
        return await call()
      } finally {
        ids.delete(id)
        onChange()
      }
    },
  }
}
