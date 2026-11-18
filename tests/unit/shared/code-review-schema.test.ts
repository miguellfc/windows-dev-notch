import { describe, expect, it } from 'vitest'
import {
  CODE_REVIEW_LIST_LIMIT,
  clearInputSchema,
  codeReviewAlertSchema,
  codeReviewStateSchema,
  gitlabUrlSchema,
  openAlertInputSchema,
  openedResultSchema,
  openProfileInputSchema,
  platformSchema,
  platformStateSchema,
  reviewStateSchema,
  setTokenInputSchema,
  setTokenResultSchema,
} from '../../../src/shared/code-review/schema'

const platformState = { status: 'ok', account: 'me', unreviewed: 2, updatedAt: '2026-11-12T10:00:00.000Z', persistent: true }

describe('code review enums', () => {
  it('accepts only the two platforms', () => {
    expect(platformSchema.options).toEqual(['github', 'gitlab'])
    expect(platformSchema.safeParse('bitbucket').success).toBe(false)
  })

  it('accepts the review states', () => {
    for (const s of ['none', 'approved', 'changes', 'commented']) expect(reviewStateSchema.safeParse(s).success).toBe(true)
    expect(reviewStateSchema.safeParse('dismissed').success).toBe(false)
  })

  it('keeps the own PR/MR limit main reads', () => {
    expect(CODE_REVIEW_LIST_LIMIT).toBe(20)
  })
})

describe('platform and code review state', () => {
  it('accepts a full state and rejects unknown statuses and keys', () => {
    expect(platformStateSchema.parse(platformState)).toEqual(platformState)
    expect(platformStateSchema.safeParse({ ...platformState, status: 'expired' }).success).toBe(false)
    expect(platformStateSchema.safeParse({ ...platformState, extra: 1 }).success).toBe(false)
    expect(platformStateSchema.safeParse({ ...platformState, unreviewed: -1 }).success).toBe(false)
    expect(platformStateSchema.safeParse({ ...platformState, unreviewed: 1.5 }).success).toBe(false)
    for (const status of ['unconfigured', 'ok', 'offline', 'auth-error']) {
      expect(platformStateSchema.safeParse({ ...platformState, status }).success).toBe(true)
    }
    expect(
      platformStateSchema.safeParse({ status: 'unconfigured', account: null, unreviewed: null, updatedAt: null, persistent: false }).success,
    ).toBe(true)
  })

  it('needs both platforms', () => {
    expect(codeReviewStateSchema.safeParse({ github: platformState, gitlab: platformState }).success).toBe(true)
    expect(codeReviewStateSchema.safeParse({ github: platformState }).success).toBe(false)
    expect(codeReviewStateSchema.safeParse({ github: platformState, gitlab: platformState, x: platformState }).success).toBe(false)
  })
})

describe('codeReviewAlertSchema', () => {
  it('accepts a single alert with kind, ref and title, or a count only', () => {
    expect(codeReviewAlertSchema.safeParse({ platform: 'github', count: 1, kind: 'approved', ref: 'o/r#1', title: 't' }).success).toBe(true)
    expect(codeReviewAlertSchema.safeParse({ platform: 'gitlab', count: 3 }).success).toBe(true)
  })

  it('is strict', () => {
    expect(codeReviewAlertSchema.safeParse({ platform: 'github', count: 0 }).success).toBe(false)
    expect(codeReviewAlertSchema.safeParse({ platform: 'github', count: 1, kind: 'none' }).success).toBe(false)
    expect(codeReviewAlertSchema.safeParse({ platform: 'github', count: 1, extra: true }).success).toBe(false)
    expect(codeReviewAlertSchema.safeParse({ platform: 'x', count: 1 }).success).toBe(false)
  })
})

describe('gitlabUrlSchema', () => {
  it('normalizes to origin plus base path without a trailing slash', () => {
    expect(gitlabUrlSchema.parse('https://gitlab.x.com/')).toBe('https://gitlab.x.com')
    expect(gitlabUrlSchema.parse('https://gitlab.x.com')).toBe('https://gitlab.x.com')
    expect(gitlabUrlSchema.parse('  https://GitLab.X.com/gitlab/  ')).toBe('https://gitlab.x.com/gitlab')
    expect(gitlabUrlSchema.parse('https://gitlab.x.com:8443/a/b//')).toBe('https://gitlab.x.com:8443/a/b')
  })

  it('rejects http, credentials, query, hash and non-URLs', () => {
    for (const url of [
      'http://gitlab.x.com',
      'https://user@gitlab.x.com',
      'https://user:pass@gitlab.x.com',
      'https://gitlab.x.com/?a=1',
      'https://gitlab.x.com/#top',
      'gitlab.x.com',
      'ftp://gitlab.x.com',
      'javascript:alert(1)',
      '',
      `https://gitlab.x.com/${'a'.repeat(600)}`,
    ]) {
      expect(gitlabUrlSchema.safeParse(url).success, url).toBe(false)
    }
  })
})

describe('IPC inputs', () => {
  it('clear, open-profile and open-alert take only a platform, never an id or a URL', () => {
    expect(clearInputSchema.safeParse({ platform: 'gitlab' }).success).toBe(true)
    expect(clearInputSchema.safeParse({}).success).toBe(false)
    for (const schema of [openProfileInputSchema, openAlertInputSchema]) {
      expect(schema.safeParse({ platform: 'github' }).success).toBe(true)
      expect(schema.safeParse({ platform: 'bitbucket' }).success).toBe(false)
      expect(schema.safeParse({}).success).toBe(false)
      expect(schema.safeParse({ platform: 'github', id: '12!3' }).success).toBe(false)
      expect(schema.safeParse({ platform: 'github', url: 'https://github.com/x' }).success).toBe(false)
    }
  })

  it('the openers answer one boolean and nothing else', () => {
    expect(openedResultSchema.parse({ opened: true })).toEqual({ opened: true })
    expect(openedResultSchema.safeParse({ opened: false }).success).toBe(true)
    expect(openedResultSchema.safeParse({}).success).toBe(false)
    expect(openedResultSchema.safeParse({ opened: 'yes' }).success).toBe(false)
    expect(openedResultSchema.safeParse({ opened: true, url: 'https://github.com/x' }).success).toBe(false)
  })

  it('set-token bounds the token to 1-255 characters and takes an optional url', () => {
    expect(setTokenInputSchema.safeParse({ platform: 'github', token: 't' }).success).toBe(true)
    expect(setTokenInputSchema.safeParse({ platform: 'github', token: 't'.repeat(255) }).success).toBe(true)
    expect(setTokenInputSchema.safeParse({ platform: 'github', token: '' }).success).toBe(false)
    expect(setTokenInputSchema.safeParse({ platform: 'github', token: 't'.repeat(256) }).success).toBe(false)
    expect(setTokenInputSchema.safeParse({ platform: 'gitlab', token: 't', url: 'https://gitlab.x.com' }).success).toBe(true)
    expect(setTokenInputSchema.safeParse({ platform: 'gitlab', token: 't', url: 'x'.repeat(513) }).success).toBe(false)
    expect(setTokenInputSchema.safeParse({ platform: 'gitlab', token: 't', extra: 1 }).success).toBe(false)
  })

  it('set-token result is ok with an account or a reason', () => {
    expect(setTokenResultSchema.safeParse({ ok: true, account: 'me' }).success).toBe(true)
    for (const reason of ['auth', 'network', 'url']) expect(setTokenResultSchema.safeParse({ ok: false, reason }).success).toBe(true)
    expect(setTokenResultSchema.safeParse({ ok: false, reason: 'server' }).success).toBe(false)
  })
})
