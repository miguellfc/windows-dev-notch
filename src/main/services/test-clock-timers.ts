export interface RealTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface TestClockTimers extends RealTimers {
  /** Runs (once) every pending timer whose due time the test clock has reached. */
  fireDue(): void
}

/**
 * Dev/E2E only (`NOTCH_TEST_CLOCK=1`, never in a packaged build): timers that still fire in real
 * time, and also fire early when the test clock (`now`, real time plus an offset) is moved past
 * their due time. Lets an E2E test reach a 60 s poll without waiting a minute.
 */
export function createTestClockTimers(
  now: () => number,
  real: RealTimers = { setTimeout, clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
): TestClockTimers {
  const pending = new Map<object, { due: number; callback: () => void; handle: unknown }>()

  return {
    setTimeout(callback, ms) {
      const key = {}
      const entry = { due: now() + ms, callback, handle: null as unknown }
      entry.handle = real.setTimeout(() => {
        if (pending.delete(key)) callback()
      }, ms)
      pending.set(key, entry)
      return key
    },

    clearTimeout(handle) {
      const entry = typeof handle === 'object' && handle !== null ? pending.get(handle) : undefined
      if (!entry) return
      real.clearTimeout(entry.handle)
      pending.delete(handle as object)
    },

    fireDue() {
      const at = now()
      // A snapshot: timers armed by these callbacks wait for a later move.
      for (const [key, entry] of [...pending]) {
        if (entry.due > at || !pending.has(key)) continue
        pending.delete(key)
        real.clearTimeout(entry.handle)
        entry.callback()
      }
    },
  }
}
