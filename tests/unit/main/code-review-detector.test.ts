import { describe, expect, it } from 'vitest'
import { createReviewDetector } from '../../../src/main/code-review/review-detector'
import type { ReviewState } from '../../../src/shared/code-review/schema'

const own = (entries: Record<string, ReviewState>) => Object.entries(entries).map(([id, review]) => ({ id, review }))

describe('review detector', () => {
  it('only records the reference on the first observation', () => {
    const detector = createReviewDetector()
    expect(detector.observe(own({ a: 'approved', b: 'none' }))).toEqual([])
  })

  it('reports none -> approved, changes and commented with their kind', () => {
    for (const kind of ['approved', 'changes', 'commented'] as const) {
      const detector = createReviewDetector()
      detector.observe(own({ a: 'none' }))
      expect(detector.observe(own({ a: kind })), kind).toEqual([{ id: 'a', kind }])
    }
  })

  it('reports a transition once', () => {
    const detector = createReviewDetector()
    detector.observe(own({ a: 'none' }))
    expect(detector.observe(own({ a: 'approved' }))).toEqual([{ id: 'a', kind: 'approved' }])
    expect(detector.observe(own({ a: 'approved' }))).toEqual([])
  })

  it('does not report an already reviewed item that changes kind', () => {
    const detector = createReviewDetector()
    detector.observe(own({ a: 'commented' }))
    expect(detector.observe(own({ a: 'approved' }))).toEqual([])
    expect(detector.observe(own({ a: 'changes' }))).toEqual([])
  })

  it('does not report items that disappear (closed or merged)', () => {
    const detector = createReviewDetector()
    detector.observe(own({ a: 'none', b: 'none' }))
    expect(detector.observe(own({ b: 'none' }))).toEqual([])
  })

  it('does not report a new item that is already reviewed', () => {
    const detector = createReviewDetector()
    detector.observe(own({ a: 'none' }))
    expect(detector.observe(own({ a: 'none', b: 'approved' }))).toEqual([])
  })

  it('reports a new item only after it was seen unreviewed', () => {
    const detector = createReviewDetector()
    detector.observe(own({}))
    expect(detector.observe(own({ b: 'none' }))).toEqual([])
    expect(detector.observe(own({ b: 'changes' }))).toEqual([{ id: 'b', kind: 'changes' }])
  })

  it('reports several at once in list order', () => {
    const detector = createReviewDetector()
    detector.observe(own({ a: 'none', b: 'none', c: 'none', d: 'approved' }))
    expect(detector.observe(own({ c: 'commented', a: 'approved', b: 'none', d: 'approved' }))).toEqual([
      { id: 'c', kind: 'commented' },
      { id: 'a', kind: 'approved' },
    ])
  })

  it('reset makes the next observation a baseline again', () => {
    const detector = createReviewDetector()
    detector.observe(own({ a: 'none' }))
    detector.reset()
    expect(detector.observe(own({ a: 'approved' }))).toEqual([])
    expect(detector.observe(own({ a: 'approved' }))).toEqual([])
  })

  it('a reopened item that comes back reviewed does not alert', () => {
    const detector = createReviewDetector()
    detector.observe(own({ a: 'none' }))
    detector.observe(own({}))
    expect(detector.observe(own({ a: 'approved' }))).toEqual([])
  })
})
