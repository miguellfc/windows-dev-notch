import { describe, expect, it } from 'vitest'
import {
  logTimeInputSchema,
  redmineIssueDetailSchema,
  redmineIssueSchema,
  redmineStateSchema,
  redmineWriteResultSchema,
  setKeyInputSchema,
  updateIssueInputSchema,
} from '../../../src/shared/redmine/schema'
import { isStoredRedmineUrl, normalizeRedmineUrl, redmineUrlSchema } from '../../../src/shared/redmine/url'

const pad = (n: number) => String(n).padStart(2, '0')
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const today = dayKey(new Date())
const tomorrow = dayKey(new Date(Date.now() + 36 * 3600_000))

const log = (over: Record<string, unknown>) => ({ issueId: 1, spentOn: today, hours: 1, activityId: 9, comments: '', ...over })

describe('logTimeInputSchema', () => {
  it('accepts valid hours and rejects 0, > 24 and more than 2 decimals', () => {
    for (const hours of [0.01, 1, 5.5, 24]) expect(logTimeInputSchema.safeParse(log({ hours })).success, String(hours)).toBe(true)
    for (const hours of [0, 24.01, 1.234, -1, Number.NaN]) expect(logTimeInputSchema.safeParse(log({ hours })).success, String(hours)).toBe(false)
  })

  it('rejects a future date and malformed dates', () => {
    expect(logTimeInputSchema.safeParse(log({ spentOn: tomorrow })).success).toBe(false)
    expect(logTimeInputSchema.safeParse(log({ spentOn: '2026-13-01' })).success).toBe(false)
    expect(logTimeInputSchema.safeParse(log({ spentOn: '2026-1-1' })).success).toBe(false)
  })

  it('limits the comment to 255 characters', () => {
    expect(logTimeInputSchema.safeParse(log({ comments: 'a'.repeat(255) })).success).toBe(true)
    expect(logTimeInputSchema.safeParse(log({ comments: 'a'.repeat(256) })).success).toBe(false)
  })

  it('is strict', () => {
    expect(logTimeInputSchema.safeParse(log({ extra: 1 })).success).toBe(false)
  })
})

describe('updateIssueInputSchema', () => {
  it('rejects an empty update', () => {
    expect(updateIssueInputSchema.safeParse({ id: 1 }).success).toBe(false)
  })

  it('accepts a status, an estimate or null to clear it', () => {
    expect(updateIssueInputSchema.safeParse({ id: 1, statusId: 3 }).success).toBe(true)
    expect(updateIssueInputSchema.safeParse({ id: 1, estimatedHours: 0 }).success).toBe(true)
    expect(updateIssueInputSchema.safeParse({ id: 1, estimatedHours: 999 }).success).toBe(true)
    expect(updateIssueInputSchema.safeParse({ id: 1, estimatedHours: 2.25 }).success).toBe(true)
    expect(updateIssueInputSchema.safeParse({ id: 1, estimatedHours: null }).success).toBe(true)
  })

  it('bounds the estimate', () => {
    for (const estimatedHours of [-1, 999.01, 1.234]) {
      expect(updateIssueInputSchema.safeParse({ id: 1, estimatedHours }).success, String(estimatedHours)).toBe(false)
    }
  })
})

describe('setKeyInputSchema', () => {
  it('needs a key of 1 to 255 characters', () => {
    expect(setKeyInputSchema.safeParse({ url: 'https://r.x.com', key: 'k' }).success).toBe(true)
    expect(setKeyInputSchema.safeParse({ url: 'https://r.x.com', key: '' }).success).toBe(false)
    expect(setKeyInputSchema.safeParse({ url: 'https://r.x.com', key: 'k'.repeat(256) }).success).toBe(false)
  })
})

describe('data schemas', () => {
  const issue = {
    id: 12,
    subject: 'Fix',
    project: 'P',
    status: { id: 1, name: 'New' },
    estimatedHours: null,
    spentHours: 2.5,
    updatedOn: '2026-11-14T10:00:00Z',
  }

  it('parses issues and details', () => {
    expect(redmineIssueSchema.parse(issue)).toEqual(issue)
    const detail = { ...issue, allowedStatuses: [{ id: 2, name: 'Done' }] }
    expect(redmineIssueDetailSchema.parse(detail)).toEqual(detail)
    expect(redmineIssueSchema.safeParse({ ...issue, extra: 1 }).success).toBe(false)
  })

  it('parses state and write results', () => {
    const state = { status: 'ok', account: 'ana', todayHours: 0, updatedAt: 1, persistent: true }
    expect(redmineStateSchema.parse(state)).toEqual(state)
    expect(redmineStateSchema.safeParse({ ...state, status: 'nope' }).success).toBe(false)
    expect(redmineWriteResultSchema.safeParse({ ok: true }).success).toBe(true)
    expect(redmineWriteResultSchema.safeParse({ ok: false, reason: 'validation', messages: ['x'] }).success).toBe(true)
    expect(redmineWriteResultSchema.safeParse({ ok: false, reason: 'bad' }).success).toBe(false)
  })
})

describe('normalizeRedmineUrl', () => {
  it('keeps origin plus base path without trailing slash', () => {
    expect(normalizeRedmineUrl('https://r.x.com/')).toBe('https://r.x.com')
    expect(normalizeRedmineUrl('  https://r.x.com/redmine/ ')).toBe('https://r.x.com/redmine')
  })

  it('rejects http, credentials, query, hash and over-long input', () => {
    for (const raw of ['http://r.x.com', 'https://u:p@r.x.com', 'https://r.x.com?a=1', 'https://r.x.com/#x', 'https://r.x.com?', '', 'nope']) {
      expect(normalizeRedmineUrl(raw), raw).toBeNull()
    }
    expect(normalizeRedmineUrl(`https://r.x.com/${'a'.repeat(512)}`)).toBeNull()
  })

  it('has a schema and a stored-form check', () => {
    expect(redmineUrlSchema.parse('https://r.x.com/b/')).toBe('https://r.x.com/b')
    expect(redmineUrlSchema.safeParse('http://r.x.com').success).toBe(false)
    expect(isStoredRedmineUrl('')).toBe(true)
    expect(isStoredRedmineUrl('https://r.x.com/b')).toBe(true)
    expect(isStoredRedmineUrl('https://r.x.com/b/')).toBe(false)
  })
})
