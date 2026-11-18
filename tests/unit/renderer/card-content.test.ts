import { describe, expect, it } from 'vitest'
import type { ClaudeSession } from '../../../src/shared/claude/types'
import type { GmailMessage, GmailState } from '../../../src/shared/gmail/schema'
import { translate, type MessageKey, type MessageParams } from '../../../src/shared/i18n/messages'
import type { Note } from '../../../src/shared/notes/schema'
import { gmailCardBody, redmineProgress, sessionLine, topNotes, topSessions } from '../../../src/renderer/notch/panel/cards/card-content'

const NOW = Date.UTC(2026, 10, 18, 12)
const MINUTE = 60_000

const session = (id: string, status: ClaudeSession['status'], minutesAgo = 0): ClaudeSession => ({
  id,
  name: id,
  status,
  updatedAt: NOW - minutesAgo * MINUTE,
})

const es = (key: MessageKey, params?: MessageParams) => translate('es', key, params)
const en = (key: MessageKey, params?: MessageParams) => translate('en', key, params)

describe('topSessions', () => {
  it('puts the waiting sessions first', () => {
    const top = topSessions([session('a', 'working'), session('b', 'idle'), session('c', 'waiting', 30)])
    expect(top.map((s) => s.id)).toEqual(['c', 'a'])
  })

  it('keeps two at most by default', () => {
    expect(topSessions([session('a', 'working'), session('b', 'working'), session('c', 'working')])).toHaveLength(2)
  })

  it('takes another limit', () => {
    expect(topSessions([session('a', 'working'), session('b', 'working')], 1)).toHaveLength(1)
  })
})

describe('sessionLine', () => {
  it('says what a waiting session waits for and for how long', () => {
    expect(sessionLine(session('a', 'waiting', 2), NOW, 'es-ES', es).normalize('NFKC')).toBe('espera permiso · 2 min')
  })

  it('says how long a session has been working', () => {
    expect(sessionLine(session('a', 'working', 14), NOW, 'es-ES', es).normalize('NFKC')).toBe('trabajando · 14 min')
  })

  it('speaks English too', () => {
    expect(sessionLine(session('a', 'working', 14), NOW, 'en-US', en).normalize('NFKC')).toBe('working · 14 min')
  })

  it('has no seconds to count under a minute: the clock only ticks every minute', () => {
    expect(sessionLine(session('a', 'working'), NOW, 'es-ES', es)).toBe('trabajando · ahora')
  })

  it('moves up to hours', () => {
    expect(sessionLine(session('a', 'idle', 120), NOW, 'es-ES', es).normalize('NFKC')).toBe('inactiva · 2 h')
  })
})

describe('topNotes', () => {
  const note = (id: string, pinned: boolean, updatedAt: string): Note => ({ id, text: id, pinned, createdAt: updatedAt, updatedAt })

  it('puts the pinned notes first even when they are older', () => {
    const top = topNotes([note('new', false, '2026-11-18T10:00:00.000Z'), note('pinned', true, '2026-01-01T10:00:00.000Z')])
    expect(top.map((n) => n.id)).toEqual(['pinned', 'new'])
  })

  it('orders the rest by the latest edit and keeps three', () => {
    const top = topNotes([
      note('a', false, '2026-11-15T10:00:00.000Z'),
      note('b', false, '2026-11-18T10:00:00.000Z'),
      note('c', false, '2026-11-17T10:00:00.000Z'),
      note('d', false, '2026-11-16T10:00:00.000Z'),
    ])
    expect(top.map((n) => n.id)).toEqual(['b', 'c', 'd'])
  })
})

describe('redmineProgress', () => {
  it('is the share of the target', () => {
    expect(redmineProgress(4, 8)).toBe(0.5)
  })

  it('stops at the target', () => {
    expect(redmineProgress(10, 8)).toBe(1)
  })

  it('is empty without hours', () => {
    expect(redmineProgress(null, 8)).toBe(0)
  })

  it('is empty without a target to measure against', () => {
    expect(redmineProgress(4, 0)).toBe(0)
  })
})

describe('gmailCardBody', () => {
  const state = (status: GmailState['status'], unread: number | null = 0): GmailState => ({
    status,
    account: null,
    unread,
    updatedAt: null,
    persistent: true,
    reason: null,
  })
  const mail: GmailMessage = { id: 'm', threadId: 't', from: 'Ana', subject: 'Hola', snippet: '', date: '', unread: true }

  it('is loading before the first reading', () => {
    expect(gmailCardBody(null, null)).toBe('loading')
  })

  it('shows the session states as they are', () => {
    expect(gmailCardBody(state('unconfigured'), null)).toBe('unconfigured')
    expect(gmailCardBody(state('signed-out'), null)).toBe('signed-out')
    expect(gmailCardBody(state('signing-in'), null)).toBe('signing-in')
    expect(gmailCardBody(state('expired'), null)).toBe('expired')
  })

  it('is loading until the list is read', () => {
    expect(gmailCardBody(state('ok', 2), null)).toBe('loading')
  })

  it('never calls the mailbox empty while the count says there is unread mail', () => {
    expect(gmailCardBody(state('ok', 3), [])).toBe('loading')
  })

  it('does not trust an empty list without a count', () => {
    expect(gmailCardBody(state('ok', null), [])).toBe('loading')
  })

  it('is empty when the list and the count agree', () => {
    expect(gmailCardBody(state('ok', 0), [])).toBe('empty')
  })

  it('shows the list it has, online or not', () => {
    expect(gmailCardBody(state('ok', 1), [mail])).toBe('list')
    expect(gmailCardBody(state('offline', 1), [mail])).toBe('list')
  })

  it('says it is offline when it has no mail to show', () => {
    expect(gmailCardBody(state('offline', 1), null)).toBe('offline')
    expect(gmailCardBody(state('offline', 0), [])).toBe('offline')
  })
})
