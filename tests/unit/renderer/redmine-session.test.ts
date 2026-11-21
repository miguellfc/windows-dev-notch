import { describe, expect, it } from 'vitest'
import { EMPTY_REDMINE } from '../../../src/renderer/notch/system/capsule-latch'
import { nextRedmineSession } from '../../../src/renderer/shared/redmine/session'
import type { RedmineState, RedmineStatus, RedmineSummary } from '../../../src/shared/redmine/schema'

const reading = (status: RedmineStatus, account: string | null = 'Alice'): RedmineState => ({
  status,
  account,
  todayHours: 2,
  monthHours: 2,
  updatedAt: 1,
  persistent: true,
})
const SUMMARY: RedmineSummary = { month: '2026-11', days: [{ date: '2026-11-14', hours: 2 }], today: 2, week: 10, monthTotal: 30 }
const withSummary = (state: RedmineState | null) => ({ state, block: EMPTY_REDMINE, summary: SUMMARY, summaryError: true })

describe('nextRedmineSession', () => {
  it('keeps the summary while the same session stays ok or offline', () => {
    const next = nextRedmineSession(withSummary(reading('ok')), reading('offline'))
    expect(next.state?.status).toBe('offline')
    expect(next.block.hours).toBe(2)
    expect('summary' in next).toBe(false)
    expect('summaryError' in nextRedmineSession(withSummary(reading('offline')), reading('ok'))).toBe(false)
  })

  it('forgets the summary and its error when the session ends', () => {
    for (const status of ['unconfigured', 'auth-error'] as const) {
      expect(nextRedmineSession(withSummary(reading('ok')), reading(status))).toMatchObject({ summary: null, summaryError: false })
    }
  })

  it('forgets the summary when another account takes over', () => {
    expect(nextRedmineSession(withSummary(reading('ok', 'Alice')), reading('ok', 'Bob'))).toMatchObject({ summary: null, summaryError: false })
  })

  it('keeps a summary that arrived before the first state reading', () => {
    expect('summary' in nextRedmineSession(withSummary(null), reading('ok'))).toBe(false)
  })
})
