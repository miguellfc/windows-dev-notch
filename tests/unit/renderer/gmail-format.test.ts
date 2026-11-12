import { describe, expect, it } from 'vitest'
import { formatReceived, formatUpdated, gmailBody, subjectText, unreadLabel, unreadText } from '../../../src/renderer/shared/gmail/format'
import type { GmailState, GmailStatus } from '../../../src/shared/gmail/schema'

const NOW = new Date(2026, 10, 11, 12, 0) // Wednesday 11 November 2026, 12:00 local
const MIN = 60_000
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString()

describe('unreadText', () => {
  it('shows the count, and the cap (100) as "99+"', () => {
    expect(unreadText(1)).toBe('1')
    expect(unreadText(99)).toBe('99')
    expect(unreadText(100)).toBe('99+')
  })
})

describe('unreadLabel', () => {
  it('names the count in a sentence, singular for one', () => {
    expect(unreadLabel(1, 'es')).toBe('1 correo sin leer')
    expect(unreadLabel(1, 'en')).toBe('1 unread email')
    expect(unreadLabel(3, 'es')).toBe('3 correos sin leer')
    expect(unreadLabel(3, 'en')).toBe('3 unread emails')
    expect(unreadLabel(100, 'es')).toBe('99+ correos sin leer')
  })
})

describe('formatReceived', () => {
  it('uses the notes format for how long ago a message arrived', () => {
    expect(formatReceived(ago(30_000), NOW, 'es')).toBe('ahora')
    expect(formatReceived(ago(3 * MIN), NOW, 'es')).toBe('hace 3 min')
    expect(formatReceived(ago(2 * 60 * MIN), NOW, 'en')).toMatch(/^2 hr\.? ago$/)
    expect(formatReceived(ago(24 * 60 * MIN), NOW, 'en')).toBe('yesterday')
  })

  it('gives nothing for an unreadable date', () => {
    expect(formatReceived('not a date', NOW, 'es')).toBe('')
  })
})

describe('formatUpdated', () => {
  it('says when the data was last fetched', () => {
    expect(formatUpdated(ago(3 * MIN), NOW, 'es')).toBe('Actualizado hace 3 min')
    expect(formatUpdated(ago(10_000), NOW, 'en')).toBe('Updated just now')
  })

  it('gives nothing without a successful query', () => {
    expect(formatUpdated(null, NOW, 'es')).toBe('')
    expect(formatUpdated('garbage', NOW, 'es')).toBe('')
  })
})

describe('subjectText', () => {
  it('keeps the subject, or says there is none', () => {
    expect(subjectText('Factura de noviembre', 'es')).toBe('Factura de noviembre')
    expect(subjectText('', 'es')).toBe('(sin asunto)')
    expect(subjectText('   ', 'en')).toBe('(no subject)')
  })
})

describe('gmailBody', () => {
  const OPENED = Date.parse('2026-11-11T12:00:00.000Z')
  const BEFORE = '2026-11-11T11:59:00.000Z'
  const AFTER = '2026-11-11T12:00:05.000Z'
  const state = (status: GmailStatus, unread: number | null = 0, updatedAt: string | null = AFTER): GmailState => ({
    status,
    account: null,
    unread,
    updatedAt,
    persistent: true,
  })
  const message = { id: 'm1', threadId: 't1', from: 'Ana', subject: 'Hola', snippet: '', date: AFTER, unread: true }

  it('loads until the first state and the first list arrive', () => {
    expect(gmailBody(null, null, OPENED)).toBe('loading')
    expect(gmailBody(state('ok'), null, OPENED)).toBe('loading')
  })

  it('shows why there is no list for a session that is not live', () => {
    for (const status of ['unconfigured', 'signed-out', 'signing-in', 'expired'] as const) {
      expect(gmailBody(state(status, null, null), { messages: [message], forUpdate: AFTER }, OPENED)).toBe(status)
    }
  })

  it('shows the list whenever there is one, ok or offline', () => {
    expect(gmailBody(state('ok', 1), { messages: [message], forUpdate: BEFORE }, OPENED)).toBe('list')
    expect(gmailBody(state('offline', 1), { messages: [message], forUpdate: BEFORE }, OPENED)).toBe('list')
  })

  it('does not trust an empty list from before the view opened while ok', () => {
    expect(gmailBody(state('ok', 0, BEFORE), { messages: [], forUpdate: BEFORE }, OPENED)).toBe('loading')
    expect(gmailBody(state('ok', 0), { messages: [], forUpdate: AFTER }, OPENED)).toBe('empty')
  })

  it('never says Primary is empty while the count says there is unread mail', () => {
    expect(gmailBody(state('ok', 3), { messages: [], forUpdate: AFTER }, OPENED)).toBe('loading')
  })

  it('says empty when offline with nothing kept, after a query that counted 0 unread', () => {
    expect(gmailBody(state('offline', 0, BEFORE), { messages: [], forUpdate: BEFORE }, OPENED)).toBe('empty')
  })

  it('offline with no list never says empty next to unread mail or before any data', () => {
    expect(gmailBody(state('offline', 3, BEFORE), { messages: [], forUpdate: BEFORE }, OPENED)).toBe('loading')
    expect(gmailBody(state('offline', null, null), { messages: [], forUpdate: null }, OPENED)).toBe('loading')
    expect(gmailBody(state('offline', 0, null), { messages: [], forUpdate: null }, OPENED)).toBe('loading')
  })
})
