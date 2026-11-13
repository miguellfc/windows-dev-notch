import type { ReviewKind, ReviewState } from '../../shared/code-review/schema'

export interface ReviewDetector {
  /**
   * Compares the review state of the own open PR/MRs with the previous query and returns those
   * that went from `none` to reviewed, in list order. Items that disappear (closed or merged),
   * new items that are already reviewed and reviewed items that change kind are not reported.
   * The first call after creation or `reset()` only records the reference and returns `[]`.
   */
  observe(own: ReadonlyArray<{ id: string; review: ReviewState }>): { id: string; kind: ReviewKind }[]
  /** Forgets the reference: the next observation is a baseline again (token or URL change). */
  reset(): void
}

/** First-review detection by diffing review states between queries: no extra requests. Pure, in memory. */
export function createReviewDetector(): ReviewDetector {
  let previous: ReadonlyMap<string, ReviewState> | null = null

  return {
    observe(own) {
      const current = new Map(own.map(({ id, review }) => [id, review]))
      const before = previous
      previous = current
      if (before === null) return []
      const reviewed: { id: string; kind: ReviewKind }[] = []
      for (const [id, review] of current) {
        if (review !== 'none' && before.get(id) === 'none') reviewed.push({ id, kind: review })
      }
      return reviewed
    },
    reset() {
      previous = null
    },
  }
}
