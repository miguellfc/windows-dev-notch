import { describe, expect, it } from 'vitest'
import {
  CAPSULE_MISSES,
  contributionBlockCount,
  EMPTY_CONTRIBUTION_BLOCKS,
  nextContributionBlocks,
  type ContributionBlocks,
} from '../../../src/renderer/notch/system/capsule-latch'
import type { CodeReviewState, ContributionsResult, ContributionSummary, Platform, PlatformState, PlatformStatus } from '../../../src/shared/code-review/schema'

const platform = (status: PlatformStatus): PlatformState => ({
  status,
  account: status === 'unconfigured' ? null : 'someone',
  unreviewed: null,
  updatedAt: '2026-11-13T12:00:00.000Z',
  persistent: true,
})
const state = (github: PlatformStatus, gitlab: PlatformStatus = 'unconfigured'): CodeReviewState => ({ github: platform(github), gitlab: platform(gitlab) })
const answer = (monthTotal: number | null, month = '2026-11', error = false): ContributionsResult => ({
  summary: monthTotal === null ? null : ({ month, monthTotal } as ContributionSummary),
  error,
})

/** One reading: the state and the contributions answers the store holds at that moment. */
type Reading = [CodeReviewState | null, Partial<Record<Platform, ContributionsResult>>]
const feed = (readings: Reading[], from: ContributionBlocks = EMPTY_CONTRIBUTION_BLOCKS): ContributionBlocks =>
  readings.reduce((blocks, [current, contributions]) => nextContributionBlocks(blocks, current, contributions), from)

describe('nextContributionBlocks', () => {
  it('starts with no blocks and shows one per live platform with its month total', () => {
    expect(contributionBlockCount(EMPTY_CONTRIBUTION_BLOCKS)).toBe(0)
    const both = feed([[state('ok', 'offline'), { github: answer(143), gitlab: answer(2500) }]])
    expect(both.github).toEqual({ total: 143, month: '2026-11', missRun: 0 })
    expect(both.gitlab.total).toBe(2500)
    expect(contributionBlockCount(both)).toBe(2)
  })

  it('shows a live 0; never without a summary yet, unconfigured or auth-error', () => {
    expect(feed([[state('ok'), { github: answer(0) }]]).github.total).toBe(0)
    expect(feed([[state('offline'), { github: answer(0) }]]).github.total).toBe(0)
    expect(feed([[state('ok'), {}]]).github.total).toBeNull()
    expect(feed([[state('ok'), { github: answer(null) }]]).github.total).toBeNull()
    expect(feed([[state('unconfigured'), { github: answer(3) }]]).github.total).toBeNull()
    expect(feed([[state('auth-error'), { github: answer(3) }]]).github.total).toBeNull()
    expect(feed([[null, { github: answer(3) }]]).github.total).toBeNull()
  })

  it('a failed query keeps its last summary: the total stays', () => {
    expect(feed([[state('ok'), { github: answer(5) }], [state('ok'), { github: answer(5, '2026-11', true) }]]).github.total).toBe(5)
  })

  it('a reading without a summary keeps the last total until the misses run out', () => {
    let blocks = feed([[state('ok'), { github: answer(4) }]])
    for (let i = 1; i < CAPSULE_MISSES; i++) {
      blocks = nextContributionBlocks(blocks, state('ok'), { github: answer(null) })
      expect(blocks.github.total).toBe(4)
    }
    blocks = nextContributionBlocks(blocks, state('ok'), { github: answer(null) })
    expect(blocks.github.total).toBeNull()
  })

  it('a new total resets the misses and follows the month; a platform that stops being live hides at once', () => {
    let blocks = feed([
      [state('ok'), { github: answer(4) }],
      [state('ok'), { github: answer(null) }],
      [state('ok'), { github: answer(1, '2026-12') }],
    ])
    expect(blocks.github).toEqual({ total: 1, month: '2026-12', missRun: 0 })
    blocks = nextContributionBlocks(blocks, state('auth-error'), { github: answer(1, '2026-12') })
    expect(blocks.github.total).toBeNull()
  })

  it('keeps each platform on its own latch', () => {
    const blocks = feed([
      [state('ok', 'ok'), { github: answer(1), gitlab: answer(3) }],
      [state('ok', 'unconfigured'), { github: answer(1), gitlab: answer(3) }],
    ])
    expect(blocks.github.total).toBe(1)
    expect(blocks.gitlab.total).toBeNull()
    expect(contributionBlockCount(blocks)).toBe(1)
  })

  it('returns the same object when nothing changes', () => {
    expect(nextContributionBlocks(EMPTY_CONTRIBUTION_BLOCKS, state('ok'), {})).toBe(EMPTY_CONTRIBUTION_BLOCKS)
    const zero = feed([[state('ok'), { github: answer(0) }]])
    expect(nextContributionBlocks(zero, state('ok'), { github: answer(0) })).toBe(zero)
  })
})
