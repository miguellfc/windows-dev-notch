import { describe, expect, it } from 'vitest'
import {
  attachmentsText,
  formatFullDate,
  formatReceived,
  formatUpdated,
  gmailBody,
  keepsReader,
  sessionKeepsReader,
  returnRowIndex,
  mailAlertContent,
  mailAlertLabel,
  senderParts,
  subjectText,
  unreadLabel,
  unreadText,
} from '../../../src/renderer/shared/gmail/format'
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
    reason: null,
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

  it('says the session needs the new permission when it expired for its scope', () => {
    const scope: GmailState = { ...state('expired', null, null), reason: 'scope' }
    expect(gmailBody(scope, null, OPENED)).toBe('scope')
    expect(gmailBody(scope, { messages: [message], forUpdate: AFTER }, OPENED)).toBe('scope')
    expect(gmailBody(state('expired', null, null), null, OPENED)).toBe('expired')
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

describe('mailAlertContent / mailAlertLabel', () => {
  it('shows sender and subject for one mail with content', () => {
    const mail = { count: 1, id: 'm1', from: 'Ana García', subject: 'Presupuesto del proyecto' }
    expect(mailAlertContent(mail, 'es')).toEqual({ kind: 'content', from: 'Ana García', subject: 'Presupuesto del proyecto' })
    expect(mailAlertLabel(mail, 'es')).toBe('Correo nuevo: Ana García · Presupuesto del proyecto')
  })

  it('says "(sin asunto)" for a blank subject', () => {
    expect(mailAlertContent({ count: 1, id: 'm1', from: 'Ana', subject: '  ' }, 'es')).toEqual({ kind: 'content', from: 'Ana', subject: '(sin asunto)' })
  })

  it('says "Correo nuevo" with hidden content or no data', () => {
    expect(mailAlertContent({ count: 1, id: 'm1' }, 'es')).toEqual({ kind: 'plain', text: 'Correo nuevo' })
    expect(mailAlertContent({ count: 1, id: 'm1', subject: 'x' }, 'en')).toEqual({ kind: 'plain', text: 'New email' })
    expect(mailAlertLabel({ count: 1, id: 'm1' }, 'es')).toBe('Correo nuevo')
  })

  it('counts several mails, whatever the content', () => {
    expect(mailAlertContent({ count: 3, id: 'm1', from: 'Ana', subject: 'Hola' }, 'es')).toEqual({ kind: 'plain', text: '3 correos nuevos' })
    expect(mailAlertLabel({ count: 3, id: 'm1' }, 'en')).toBe('3 new emails')
  })
})

describe('senderParts', () => {
  it('splits name and address, without repeating the address', () => {
    expect(senderParts('Ana García', 'ana@example.com')).toEqual({ name: 'Ana García', address: 'ana@example.com' })
    expect(senderParts('ana@example.com', 'ana@example.com')).toEqual({ name: 'ana@example.com', address: null })
    expect(senderParts('', 'ana@example.com')).toEqual({ name: 'ana@example.com', address: null })
    expect(senderParts('Ana', '')).toEqual({ name: 'Ana', address: null })
  })
})

describe('formatFullDate', () => {
  it('writes the full date and time, and nothing for a bad date', () => {
    const iso = new Date(2026, 10, 11, 9, 5).toISOString()
    expect(formatFullDate(iso, 'es')).toContain('11 de noviembre de 2026')
    expect(formatFullDate(iso, 'es')).toContain('9:05')
    expect(formatFullDate(iso, 'en')).toContain('November 11, 2026')
    expect(formatFullDate('nope', 'es')).toBe('')
  })
})

describe('attachmentsText', () => {
  it('counts attachments in the singular and the plural', () => {
    expect(attachmentsText(1, 'es')).toBe('1 adjunto')
    expect(attachmentsText(3, 'es')).toBe('3 adjuntos')
    expect(attachmentsText(2, 'en')).toBe('2 attachments')
  })
})

describe('keepsReader', () => {
  it('keeps the open message while the Gmail view or the alert that opens it is shown, and forgets it otherwise', () => {
    expect(keepsReader('gmail')).toBe(true)
    expect(keepsReader('alert')).toBe(true)
    for (const mode of ['compact', 'peek', 'expanded', 'notes', 'reminders', 'permission', 'mini', 'hidden'] as const) expect(keepsReader(mode)).toBe(false)
  })
})

describe('returnRowIndex', () => {
  it('goes back to the same message, else the row that took its place, else the last row', () => {
    expect(returnRowIndex(['a', 'b', 'c'], { id: 'b', index: 1 })).toBe(1)
    expect(returnRowIndex(['a', 'c'], { id: 'b', index: 1 })).toBe(1)
    expect(returnRowIndex(['a', 'b'], { id: 'c', index: 2 })).toBe(1)
    expect(returnRowIndex(['b', 'a'], { id: 'a', index: 0 })).toBe(1)
    expect(returnRowIndex([], { id: 'a', index: 0 })).toBeNull()
  })
})

describe('sessionKeepsReader', () => {
  const state = (status: GmailStatus): GmailState => ({ status, account: null, unread: 0, updatedAt: null, persistent: true, reason: null })

  it('keeps an open mail while the session is live, and before the first reading', () => {
    expect(sessionKeepsReader(null)).toBe(true)
    expect(sessionKeepsReader(state('ok'))).toBe(true)
    expect(sessionKeepsReader(state('offline'))).toBe(true)
  })

  it('closes it when the session drops, so the body leaves the renderer', () => {
    for (const status of ['unconfigured', 'signed-out', 'signing-in', 'expired'] as const) expect(sessionKeepsReader(state(status))).toBe(false)
    expect(sessionKeepsReader({ ...state('expired'), reason: 'scope' })).toBe(false)
  })
})
