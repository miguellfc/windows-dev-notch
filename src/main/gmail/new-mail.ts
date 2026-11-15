export interface NewMailDetector {
  /**
   * Compares the unread ids of a query with the previous one and returns the ids that were
   * not there before, in list order (newest first). The first call after creation or
   * `reset()` only records the reference and returns `[]`.
   */
  observe(unreadIds: readonly string[]): string[]
  /** Forgets the reference: the next observation is a baseline again (sign-in/out, client change, resume). */
  reset(): void
}

/** New-mail detection by diffing unread ids between queries: no extra requests. Pure, in memory. */
export function createNewMailDetector(): NewMailDetector {
  let previous: ReadonlySet<string> | null = null

  return {
    observe(unreadIds) {
      const current = new Set(unreadIds)
      const before = previous
      previous = current
      if (before === null) return []
      return [...current].filter((id) => !before.has(id))
    },
    reset() {
      previous = null
    },
  }
}
