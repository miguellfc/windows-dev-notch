import { describe, expect, it } from 'vitest'
import {
  configuredPlatforms,
  reviewAlertContent,
  reviewAlertLabel,
  reviewCountText,
  reviewsBody,
  reviewsPlatform,
  shortRef,
  splitRef,
  unreviewedLabel,
} from '../../../src/renderer/shared/code-review/format'
import type { CodeReviewState, PlatformState } from '../../../src/shared/code-review/schema'

const platform = (status: PlatformState['status'], unreviewed: number | null = 0): PlatformState => ({
  status,
  account: status === 'unconfigured' ? null : 'me',
  unreviewed,
  updatedAt: status === 'ok' ? '2026-11-13T12:00:00.000Z' : null,
  persistent: true,
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

describe('configuredPlatforms / reviewsBody', () => {
  const state = (github: PlatformState, gitlab: PlatformState): CodeReviewState => ({ github, gitlab })

  it('lists only configured platforms, GitHub first', () => {
    expect(configuredPlatforms(null)).toEqual([])
    expect(configuredPlatforms(state(platform('unconfigured'), platform('unconfigured')))).toEqual([])
    expect(configuredPlatforms(state(platform('auth-error'), platform('ok')))).toEqual(['github', 'gitlab'])
    expect(configuredPlatforms(state(platform('unconfigured'), platform('offline')))).toEqual(['gitlab'])
  })

  it('picks the body for the platform: a notice, or its contributions', () => {
    expect(reviewsBody(null)).toBe('loading')
    expect(reviewsBody(platform('unconfigured'))).toBe('unconfigured')
    expect(reviewsBody(platform('auth-error'))).toBe('auth')
    expect(reviewsBody(platform('ok'))).toBe('contributions')
    // Offline keeps the last contributions, however long ago they were read.
    expect(reviewsBody(platform('offline'))).toBe('contributions')
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

describe('reviewsPlatform', () => {
  it('keeps the requested platform even when it is not configured', () => {
    expect(reviewsPlatform('gitlab', ['github'])).toBe('gitlab')
  })

  it('falls back to the first configured platform, then to GitHub', () => {
    expect(reviewsPlatform(null, ['gitlab'])).toBe('gitlab')
    expect(reviewsPlatform(null, [])).toBe('github')
  })
})
