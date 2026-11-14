import { describe, expect, it } from 'vitest'
import { REMINDER_DONE_MESSAGE, type Reminder } from '../../../src/shared/reminders/schema'
import {
  attentionReminders,
  formatDue,
  formatTime,
  parseErrorKey,
  remindersBadgeLabel,
  reminderErrorKey,
  pendingReminders,
} from '../../../src/renderer/shared/reminders/format'

const local = (y: number, mo: number, d: number, h = 0, mi = 0): Date => new Date(y, mo - 1, d, h, mi)

// Tuesday 10 November 2026, 12:00 local.
const NOW = local(2026, 11, 10, 12, 0)

let seq = 0
const reminder = (state: Reminder['state'], dueAt: Date, text = `r${++seq}`): Reminder => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  text,
  dueAt: dueAt.toISOString(),
  repeat: 'none',
  state,
  createdAt: NOW.toISOString(),
})

describe('formatDue', () => {
  it('says today with the local time', () => {
    expect(formatDue(local(2026, 11, 10, 16, 30), NOW, 'es')).toBe('hoy 16:30')
    expect(formatDue(local(2026, 11, 10, 16, 30), NOW, 'en')).toMatch(/^today 4:30\sPM$/u)
  })

  it('says tomorrow, also right after midnight', () => {
    expect(formatDue(local(2026, 11, 11, 9, 0), NOW, 'es')).toBe('mañana 9:00')
    expect(formatDue(local(2026, 11, 11, 9, 0), NOW, 'en')).toMatch(/^tomorrow 9:00\sAM$/u)
    expect(formatDue(local(2026, 11, 11, 0, 5), local(2026, 11, 10, 23, 55), 'es')).toBe('mañana 0:05')
  })

  it('uses a short weekday within a week, and a date beyond', () => {
    expect(formatDue(local(2026, 11, 13, 8, 0), NOW, 'es')).toBe('vie 8:00')
    expect(formatDue(local(2026, 11, 13, 8, 0), NOW, 'en')).toMatch(/^Fri 8:00\sAM$/u)
    expect(formatDue(local(2026, 11, 9, 8, 0), NOW, 'es')).toBe('lun 8:00')
    expect(formatDue(local(2026, 11, 20, 8, 0), NOW, 'es')).toBe('20 nov 8:00')
  })

  it('counts calendar days across a DST change', () => {
    const night = local(2026, 10, 24, 23, 0)
    expect(formatDue(local(2026, 10, 25, 23, 30), night, 'es')).toBe('mañana 23:30')
  })
})

describe('formatTime', () => {
  it('formats a wall-clock time like the rest of the language', () => {
    expect(formatTime(local(2026, 11, 11, 9, 0), 'es')).toBe('9:00')
    expect(formatTime(local(2026, 11, 11, 9, 0), 'en')).toMatch(/^9:00\sAM$/u)
  })
})

describe('remindersBadgeLabel', () => {
  it('uses the singular for one and the plural otherwise', () => {
    expect(remindersBadgeLabel(1, 'es')).toBe('1 recordatorio vencido')
    expect(remindersBadgeLabel(3, 'es')).toBe('3 recordatorios vencidos')
    expect(remindersBadgeLabel(1, 'en')).toBe('1 due reminder')
    expect(remindersBadgeLabel(3, 'en')).toBe('3 due reminders')
  })
})

describe('attentionReminders', () => {
  it('keeps due and missed, oldest first', () => {
    const late = reminder('due', local(2026, 11, 10, 11))
    const early = reminder('missed', local(2026, 11, 9, 9))
    const list = [late, reminder('pending', local(2026, 11, 10, 13)), early, reminder('done', local(2026, 11, 8))]
    expect(attentionReminders(list).map((r) => r.id)).toEqual([early.id, late.id])
  })
})

describe('pendingReminders', () => {
  it('keeps every pending reminder, whatever its day, soonest first', () => {
    const tomorrow = reminder('pending', local(2026, 11, 11, 23, 59))
    const today = reminder('pending', local(2026, 11, 10, 18))
    const later = reminder('pending', local(2027, 1, 12, 9, 0))
    const list = [later, tomorrow, reminder('done', local(2026, 11, 12)), today, reminder('due', local(2026, 11, 10, 11))]
    expect(pendingReminders(list).map((r) => r.id)).toEqual([today.id, tomorrow.id, later.id])
  })
})

describe('error keys', () => {
  it('maps parse codes and the limit; everything else is generic', () => {
    expect(reminderErrorKey({ code: 'INVALID_INPUT', message: 'no-time' })).toBe('reminders.error.noTime')
    expect(reminderErrorKey({ code: 'INVALID_INPUT', message: 'empty-text' })).toBe('reminders.error.emptyText')
    expect(reminderErrorKey({ code: 'INVALID_INPUT', message: 'too-long' })).toBe('reminders.error.tooLong')
    expect(reminderErrorKey({ code: 'INVALID_INPUT', message: 'limit' })).toBe('reminders.error.limit')
    expect(reminderErrorKey({ code: 'INVALID_INPUT', message: 'dueAt must be in the future' })).toBe('reminders.error.past')
    expect(reminderErrorKey({ code: 'INVALID_INPUT', message: 'Invalid input: expected string' })).toBe('error.generic')
    expect(reminderErrorKey({ code: 'READ_ONLY', message: 'x' })).toBe('reminders.notice.readOnly')
    expect(reminderErrorKey({ code: 'INTERNAL', message: 'no-time' })).toBe('error.generic')
    expect(parseErrorKey('no-time')).toBe('reminders.error.noTime')
  })

  it('says the reminder no longer exists for NOT_FOUND and for one already done', () => {
    expect(reminderErrorKey({ code: 'NOT_FOUND', message: 'Reminder not found' })).toBe('reminders.error.notFound')
    expect(reminderErrorKey({ code: 'INVALID_INPUT', message: REMINDER_DONE_MESSAGE })).toBe('reminders.error.notFound')
    expect(reminderErrorKey({ code: 'INTERNAL', message: REMINDER_DONE_MESSAGE })).toBe('error.generic')
  })
})
