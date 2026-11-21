import { describe, expect, it } from 'vitest'
import type { ClaudeSession, ClaudeSessionStatus, PendingPermission } from '../../../src/shared/claude/types'
import {
  canAllow,
  DONE_VISIBLE_MS,
  dotStatus,
  formatAgo,
  hiddenPreviewChars,
  nextDoneExpiry,
  orderSessions,
  permissionButtons,
  relativeAgo,
  summarizeDots,
} from '../../../src/shared/claude/view'

const session = (status: ClaudeSessionStatus, updatedAt = 0, id: string = status): ClaudeSession => ({
  id,
  name: id,
  status,
  updatedAt,
})

describe('dotStatus', () => {
  it('hides idle and expired done sessions', () => {
    expect(dotStatus(session('idle'), 0)).toBeNull()
    expect(dotStatus(session('done', 0), DONE_VISIBLE_MS - 1)).toBe('done')
    expect(dotStatus(session('done', 0), DONE_VISIBLE_MS)).toBeNull()
    expect(dotStatus(session('error', 0), 10 * DONE_VISIBLE_MS)).toBe('error')
  })
})

describe('summarizeDots', () => {
  it('orders by attention, caps at 4 and counts the rest', () => {
    const sessions = [
      session('working', 0, 'a'),
      session('working', 0, 'b'),
      session('done', 0, 'c'),
      session('waiting', 0, 'd'),
      session('error', 0, 'e'),
      session('idle', 0, 'f'),
    ]
    const summary = summarizeDots(sessions, 1000)
    expect(summary.dots).toEqual(['waiting', 'error', 'working', 'working'])
    expect(summary.extra).toBe(1)
    expect(summary.counts).toEqual({ working: 2, waiting: 1, done: 1, error: 1 })
  })

  it('does not count dotless sessions towards the extra', () => {
    const sessions = Array.from({ length: 6 }, (_, i) => session('idle', 0, String(i)))
    expect(summarizeDots(sessions, 0)).toMatchObject({ dots: [], extra: 0 })
  })
})

describe('nextDoneExpiry', () => {
  it('returns the soonest remaining time of a visible done dot', () => {
    expect(nextDoneExpiry([session('done', 1000), session('done', 3000)], 2000)).toBe(DONE_VISIBLE_MS - 1000)
    expect(nextDoneExpiry([session('working')], 0)).toBeNull()
    expect(nextDoneExpiry([session('done', 0)], DONE_VISIBLE_MS)).toBeNull()
  })
})

describe('relative time', () => {
  it('picks whole units and never goes negative', () => {
    expect(relativeAgo(10_000, 5_000)).toEqual({ value: 0, unit: 'second' })
    expect(relativeAgo(0, 59_000)).toEqual({ value: 59, unit: 'second' })
    expect(relativeAgo(0, 3 * 60_000 + 5)).toEqual({ value: 3, unit: 'minute' })
    expect(relativeAgo(0, 2 * 3_600_000)).toEqual({ value: 2, unit: 'hour' })
    expect(relativeAgo(0, 3 * 86_400_000)).toEqual({ value: 3, unit: 'day' })
  })

  it('formats in the requested locale', () => {
    expect(formatAgo(0, 3 * 60_000, 'es-ES')).toBe('hace 3 min')
    expect(formatAgo(0, 3 * 60_000, 'en-US')).toBe('3 min. ago')
  })
})

describe('staggered done expiry', () => {
  it('re-arming after each expiry switches every dot off 8 s after its own updatedAt', () => {
    const sessions = [session('done', 1000, 'a'), session('done', 3000, 'b')]
    let now = 4000
    const offAt: Record<string, number> = {}
    for (let guard = 0; guard < 5; guard += 1) {
      const wait = nextDoneExpiry(sessions, now)
      if (wait === null) break
      now += wait
      for (const s of sessions) if (!(s.id in offAt) && dotStatus(s, now) === null) offAt[s.id] = now
    }
    expect(offAt).toEqual({ a: 1000 + DONE_VISIBLE_MS, b: 3000 + DONE_VISIBLE_MS })
  })
})

describe('canAllow', () => {
  const pending = (previewTruncated: boolean): PendingPermission => ({
    id: 'id1',
    sessionId: 's1',
    sessionName: 'proj',
    toolName: 'Bash',
    preview: 'x'.repeat(2000),
    previewTruncated,
    previewLength: previewTruncated ? 2400 : 2000,
    receivedAt: 0,
  })

  it('refuses Allow when the preview was cut, so the user never approves what they cannot see', () => {
    expect(canAllow(pending(true))).toBe(false)
    expect(canAllow(pending(false))).toBe(true)
  })

  it('counts the hidden characters for the marker', () => {
    expect(hiddenPreviewChars(pending(true))).toBe(400)
    expect(hiddenPreviewChars(pending(false))).toBe(0)
  })
})

describe('permissionButtons', () => {
  const request = (id: string, previewTruncated = false): PendingPermission => ({
    id,
    sessionId: 's1',
    sessionName: 'proj',
    toolName: 'Bash',
    preview: 'ls',
    previewTruncated,
    previewLength: previewTruncated ? 3000 : 2,
    receivedAt: 0,
  })

  it('keeps both buttons disabled for a request that has not settled yet, even right after another one settled', () => {
    expect(permissionButtons(request('b'), { settledId: 'a', submittedId: null })).toEqual({ deny: false, allow: false })
    expect(permissionButtons(request('b'), { settledId: null, submittedId: null })).toEqual({ deny: false, allow: false })
  })

  it('enables both once the shown request settled', () => {
    expect(permissionButtons(request('b'), { settledId: 'b', submittedId: null })).toEqual({ deny: true, allow: true })
  })

  it('disables both while the decision for this request is in flight', () => {
    expect(permissionButtons(request('b'), { settledId: 'b', submittedId: 'b' })).toEqual({ deny: false, allow: false })
  })

  it('keeps Deny but not Allow for a truncated preview', () => {
    expect(permissionButtons(request('b', true), { settledId: 'b', submittedId: null })).toEqual({ deny: true, allow: false })
  })
})

describe('orderSessions', () => {
  it('puts sessions that need attention first, newest first within a status', () => {
    const ordered = orderSessions([
      session('idle', 50, 'old-idle'),
      session('done', 40, 'done'),
      session('working', 10, 'working-old'),
      session('working', 30, 'working-new'),
      session('error', 5, 'error'),
      session('waiting', 1, 'waiting'),
    ])
    expect(ordered.map((s) => s.id)).toEqual(['waiting', 'error', 'working-new', 'working-old', 'done', 'old-idle'])
  })

  it('does not mutate its input', () => {
    const input = [session('done', 1, 'a'), session('waiting', 2, 'b')]
    orderSessions(input)
    expect(input.map((s) => s.id)).toEqual(['a', 'b'])
  })
})
