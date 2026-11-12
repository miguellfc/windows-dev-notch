import { describe, expect, it } from 'vitest'
import { CAPSULE_MISSES, EMPTY_MAIL, nextMail, type MailLatch } from '../../../src/renderer/notch/system/capsule-latch'
import type { GmailState, GmailStatus } from '../../../src/shared/gmail/schema'

const reading = (status: GmailStatus, unread: number | null): GmailState => ({
  status,
  account: 'someone@example.com',
  unread,
  updatedAt: '2026-11-11T12:00:00.000Z',
  persistent: true,
  reason: null,
})
const feed = (states: GmailState[], from: MailLatch = EMPTY_MAIL): MailLatch => states.reduce(nextMail, from)

describe('nextMail', () => {
  it('starts with no mail block and shows it with the first reading that has unread mail', () => {
    expect(EMPTY_MAIL.unread).toBeNull()
    expect(feed([reading('ok', 3)]).unread).toBe(3)
    expect(feed([reading('offline', 100)]).unread).toBe(100)
  })

  it('never shows the block for 0, no data, or a session that is not live', () => {
    expect(feed([reading('ok', 0)]).unread).toBeNull()
    expect(feed([reading('ok', null)]).unread).toBeNull()
    for (const status of ['unconfigured', 'signed-out', 'signing-in', 'expired'] as const) {
      expect(feed([reading(status, 5)]).unread).toBeNull()
    }
  })

  it('follows the count while it stays above 0', () => {
    expect(feed([reading('ok', 3), reading('ok', 7), reading('offline', 2)]).unread).toBe(2)
  })

  it(`keeps the last count until ${CAPSULE_MISSES} readings in a row have no unread mail`, () => {
    const shown = feed([reading('ok', 4)])
    const held = feed(Array.from({ length: CAPSULE_MISSES - 1 }, () => reading('ok', 0)), shown)
    expect(held.unread).toBe(4)
    expect(feed([reading('ok', 0)], held)).toEqual(EMPTY_MAIL)
  })

  it('restarts the count of misses when mail comes back', () => {
    const shown = feed([reading('ok', 4), reading('ok', 0), reading('ok', 0), reading('ok', 1), reading('ok', 0), reading('ok', 0)])
    expect(shown.unread).toBe(1)
  })

  it('hides at once when the session ends, since no further readings arrive', () => {
    const shown = feed([reading('ok', 4)])
    for (const status of ['unconfigured', 'signed-out', 'signing-in', 'expired'] as const) {
      expect(feed([reading(status, null)], shown)).toEqual(EMPTY_MAIL)
    }
  })
})
