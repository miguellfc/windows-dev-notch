/**
 * Numbers the requests of each key so only the newest one may show its answer: main answers a
 * superseded "check and save" with a false "network", which must never reach the screen.
 */
export function createLatestRequests<K extends string>() {
  const latest = new Map<K, number>()
  return {
    /** Starts a request of `key` (supersedes the earlier ones) and returns its number. */
    begin(key: K): number {
      const seq = (latest.get(key) ?? 0) + 1
      latest.set(key, seq)
      return seq
    },
    /** Whether `seq` is still the newest request of `key`. */
    isCurrent(key: K, seq: number): boolean {
      return latest.get(key) === seq
    },
  }
}
