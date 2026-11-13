import { describe, expect, it } from 'vitest'
import { CAPSULE_MISSES, EMPTY_REVIEW_BLOCKS, nextReviewBlocks, reviewBlockCount, type ReviewBlocks } from '../../../src/renderer/notch/system/capsule-latch'
import type { CodeReviewState, PlatformState, PlatformStatus } from '../../../src/shared/code-review/schema'

const platform = (status: PlatformStatus, unreviewed: number | null): PlatformState => ({
  status,
  account: 'someone',
  unreviewed,
  updatedAt: '2026-11-13T12:00:00.000Z',
  persistent: true,
})
const reading = (github: PlatformState, gitlab: PlatformState = platform('unconfigured', null)): CodeReviewState => ({ github, gitlab })
const feed = (states: CodeReviewState[], from: ReviewBlocks = EMPTY_REVIEW_BLOCKS): ReviewBlocks => states.reduce(nextReviewBlocks, from)

describe('nextReviewBlocks', () => {
  it('starts with no blocks and shows one per platform with the first reading over 0', () => {
    expect(reviewBlockCount(EMPTY_REVIEW_BLOCKS)).toBe(0)
    const both = feed([reading(platform('ok', 2), platform('offline', 100))])
    expect(both.github.count).toBe(2)
    expect(both.gitlab.count).toBe(100)
    expect(reviewBlockCount(both)).toBe(2)
  })

  it('never shows a block for 0, no data, unconfigured or auth-error', () => {
    expect(feed([reading(platform('ok', 0))]).github.count).toBeNull()
    expect(feed([reading(platform('ok', null))]).github.count).toBeNull()
    expect(feed([reading(platform('unconfigured', 3))]).github.count).toBeNull()
    expect(feed([reading(platform('auth-error', 3))]).github.count).toBeNull()
  })

  it('a live reading of 0 hides the block at once; no data (null) keeps the latch until the misses run out', () => {
    expect(feed([reading(platform('ok', 4)), reading(platform('ok', 0))]).github.count).toBeNull()
    expect(feed([reading(platform('offline', 4)), reading(platform('offline', 0))]).github.count).toBeNull()
    let blocks = feed([reading(platform('ok', 4))])
    for (let i = 1; i < CAPSULE_MISSES; i++) {
      blocks = nextReviewBlocks(blocks, reading(platform('ok', null)))
      expect(blocks.github.count).toBe(4)
    }
    blocks = nextReviewBlocks(blocks, reading(platform('ok', null)))
    expect(blocks.github.count).toBeNull()
  })

  it('a new count resets the misses; a platform that stops being live hides at once', () => {
    let blocks = feed([reading(platform('ok', 4)), reading(platform('ok', null)), reading(platform('ok', 5))])
    expect(blocks.github).toEqual({ count: 5, missRun: 0 })
    blocks = nextReviewBlocks(blocks, reading(platform('auth-error', null)))
    expect(blocks.github.count).toBeNull()
  })

  it('keeps each platform on its own latch', () => {
    const blocks = feed([reading(platform('ok', 1), platform('ok', 3)), reading(platform('ok', 1), platform('unconfigured', null))])
    expect(blocks.github.count).toBe(1)
    expect(blocks.gitlab.count).toBeNull()
    expect(reviewBlockCount(blocks)).toBe(1)
  })

  it('returns the same object when nothing changes', () => {
    expect(nextReviewBlocks(EMPTY_REVIEW_BLOCKS, reading(platform('ok', 0)))).toBe(EMPTY_REVIEW_BLOCKS)
  })
})
