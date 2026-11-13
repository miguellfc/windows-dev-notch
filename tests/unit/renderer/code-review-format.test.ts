import { describe, expect, it } from 'vitest'
import {
  configuredPlatforms,
  itemBadges,
  reviewAlertContent,
  reviewAlertLabel,
  reviewCountText,
  reviewsBody,
  shortRef,
  splitRef,
  unreviewedLabel,
} from '../../../src/renderer/shared/code-review/format'
import type { CodeReviewState, PlatformState, ReviewItem } from '../../../src/shared/code-review/schema'

const platform = (status: PlatformState['status'], unreviewed: number | null = 0): PlatformState => ({
  status,
  account: status === 'unconfigured' ? null : 'me',
  unreviewed,
  updatedAt: status === 'ok' ? '2026-11-13T12:00:00.000Z' : null,
  persistent: true,
})
const item = (patch: Partial<ReviewItem> = {}): ReviewItem => ({
  id: 'i1',
  ref: 'acme/web#12',
  title: 'Fix login',
  author: 'ana',
  updatedAt: '2026-11-13T11:00:00.000Z',
  draft: false,
  review: 'none',
  checks: null,
  conflicts: false,
  ...patch,
})

describe('reviewCountText / unreviewedLabel', () => {
  it('caps at 99+', () => {
    expect(reviewCountText(3)).toBe('3')
    expect(reviewCountText(99)).toBe('99')
    expect(reviewCountText(100)).toBe('99+')
  })

  it('names the platform and PR or MR, in ES and EN', () => {
    expect(unreviewedLabel('github', 2, 'es')).toBe('2 PR tuyos sin revisar en GitHub')
    expect(unreviewedLabel('gitlab', 2, 'es')).toBe('2 MR tuyos sin revisar en GitLab')
    expect(unreviewedLabel('github', 1, 'es')).toBe('1 PR tuyo sin revisar en GitHub')
    expect(unreviewedLabel('gitlab', 100, 'en')).toBe('99+ of your MRs unreviewed on GitLab')
    expect(unreviewedLabel('github', 1, 'en')).toBe('1 of your PRs unreviewed on GitHub')
  })
})

describe('reviewAlertContent / reviewAlertLabel', () => {
  it('shows the verdict, the repository name and number, and the title of a single review', () => {
    const alert = { platform: 'github' as const, count: 1, kind: 'approved' as const, ref: 'acme/web#12', title: 'Fix login' }
    expect(reviewAlertContent(alert, 'es')).toEqual({ kind: 'single', verdict: 'Aprobado', ref: 'web#12', title: 'Fix login' })
    expect(reviewAlertContent({ ...alert, kind: 'changes' }, 'es')).toMatchObject({ verdict: 'Cambios pedidos' })
    expect(reviewAlertContent({ ...alert, kind: 'commented' }, 'en')).toMatchObject({ verdict: 'Reviewed' })
    expect(reviewAlertLabel(alert, 'es')).toBe('GitHub: Aprobado · web#12 · Fix login')
  })

  it('falls back to "Revisado" and drops what is missing or blank', () => {
    expect(reviewAlertContent({ platform: 'gitlab', count: 1 }, 'es')).toEqual({ kind: 'single', verdict: 'Revisado', ref: null, title: null })
    expect(reviewAlertContent({ platform: 'gitlab', count: 1, kind: 'approved', ref: ' ', title: '' }, 'es')).toMatchObject({ ref: null, title: null })
    expect(reviewAlertLabel({ platform: 'gitlab', count: 1, kind: 'approved' }, 'en')).toBe('GitLab: Approved')
  })

  it('counts several reviews per platform', () => {
    expect(reviewAlertContent({ platform: 'github', count: 2 }, 'es')).toEqual({ kind: 'many', text: '2 PR revisados', platform: 'GitHub' })
    expect(reviewAlertContent({ platform: 'gitlab', count: 3 }, 'en')).toEqual({ kind: 'many', text: '3 MRs reviewed', platform: 'GitLab' })
    expect(reviewAlertLabel({ platform: 'gitlab', count: 2 }, 'es')).toBe('2 MR revisados · GitLab')
  })
})

describe('itemBadges', () => {
  it('marks drafts, approvals, requested changes, conflicts and checks', () => {
    expect(itemBadges(item({ draft: true }), 'toReview')).toEqual([{ key: 'draft', tone: 'neutral' }])
    expect(itemBadges(item({ review: 'approved' }), 'toReview')).toEqual([{ key: 'approved', tone: 'ok' }])
    expect(itemBadges(item({ review: 'changes' }), 'mine')).toEqual([{ key: 'changes', tone: 'wait' }])
    expect(itemBadges(item({ conflicts: true, checks: 'fail' }), 'toReview')).toEqual([
      { key: 'conflicts', tone: 'fail' },
      { key: 'checksFail', tone: 'fail' },
    ])
    expect(itemBadges(item({ checks: 'pass' }), 'toReview')).toEqual([{ key: 'checksPass', tone: 'ok' }])
    expect(itemBadges(item({ checks: 'running' }), 'toReview')).toEqual([{ key: 'checksRunning', tone: 'neutral' }])
  })

  it('says "Sin revisar" only on own, non-draft items without a review', () => {
    expect(itemBadges(item(), 'mine')).toEqual([{ key: 'unreviewed', tone: 'ice' }])
    expect(itemBadges(item(), 'toReview')).toEqual([])
    expect(itemBadges(item({ draft: true }), 'mine')).toEqual([{ key: 'draft', tone: 'neutral' }])
    expect(itemBadges(item({ review: 'commented' }), 'mine')).toEqual([])
  })
})

describe('configuredPlatforms / reviewsBody', () => {
  const state = (github: PlatformState, gitlab: PlatformState): CodeReviewState => ({ github, gitlab })

  it('lists only configured platforms, GitHub first', () => {
    expect(configuredPlatforms(null)).toEqual([])
    expect(configuredPlatforms(state(platform('unconfigured'), platform('unconfigured')))).toEqual([])
    expect(configuredPlatforms(state(platform('auth-error'), platform('ok')))).toEqual(['github', 'gitlab'])
    expect(configuredPlatforms(state(platform('unconfigured'), platform('offline')))).toEqual(['gitlab'])
  })

  it('picks the body for the platform', () => {
    const list = { toReview: [item()], mine: [] }
    const empty = { toReview: [], mine: [] }
    expect(reviewsBody(null, null)).toBe('loading')
    expect(reviewsBody(platform('unconfigured'), null)).toBe('unconfigured')
    expect(reviewsBody(platform('auth-error'), list)).toBe('auth')
    expect(reviewsBody(platform('ok'), null)).toBe('loading')
    expect(reviewsBody(platform('ok'), list)).toBe('list')
    expect(reviewsBody(platform('ok'), empty)).toBe('empty')
    expect(reviewsBody(platform('offline'), list)).toBe('list')
    // Offline before any successful query: nothing is known yet.
    expect(reviewsBody(platform('offline'), empty)).toBe('loading')
  })
})

describe('splitRef / shortRef', () => {
  it('splits the repository path from the PR or MR number', () => {
    expect(splitRef('acme/web#12')).toEqual({ repo: 'acme/web', number: '#12' })
    expect(splitRef('group/sub/project!45')).toEqual({ repo: 'group/sub/project', number: '!45' })
    expect(splitRef('odd-ref')).toEqual({ repo: 'odd-ref', number: '' })
  })

  it('keeps only the repository name in front of the number, as the alert shows it', () => {
    expect(shortRef('acme/web-frontend#1234')).toBe('web-frontend#1234')
    expect(shortRef('group/sub/project!45')).toBe('project!45')
    expect(shortRef('odd-ref')).toBe('odd-ref')
  })
})
