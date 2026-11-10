process.env.TZ = 'Europe/Madrid'

import { describe, expect, it } from 'vitest'
import { buildDueAt, nextQuarterHour, parseClock, todayIsoDate } from '../../../src/renderer/shared/reminders/form'

const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date => new Date(y, mo - 1, d, h, mi, s)

// Tuesday 10 November 2026, 16:07 local.
const NOW = local(2026, 11, 10, 16, 7)

describe('nextQuarterHour', () => {
  it.each([
    [local(2026, 11, 10, 16, 7), 'today', '16:15'],
    [local(2026, 11, 10, 16, 0), 'today', '16:15'],
    [local(2026, 11, 10, 16, 14, 59), 'today', '16:15'],
    [local(2026, 11, 10, 16, 45), 'today', '17:00'],
    [local(2026, 11, 10, 9, 59), 'today', '10:00'],
    [local(2026, 11, 10, 23, 44), 'today', '23:45'],
    [local(2026, 11, 10, 23, 50), 'tomorrow', '00:00'],
    [local(2026, 11, 10, 23, 45), 'tomorrow', '00:00'],
  ] as const)('%s → %s %s', (now, day, time) => {
    expect(nextQuarterHour(now)).toEqual({ day, time })
  })
})

describe('parseClock', () => {
  it.each([
    ['9:05', '09:05'],
    ['09:05', '09:05'],
    [' 16:30 ', '16:30'],
    ['0:00', '00:00'],
    ['23:59', '23:59'],
  ])('%s → %s', (input, expected) => {
    expect(parseClock(input)).toBe(expected)
  })

  it.each(['', '24:00', '12:60', '9:5', '905', '9h05', '-1:00', '123:00', '12:00 PM', '1:2:3'])(
    'rejects %j',
    (input) => {
      expect(parseClock(input)).toBeNull()
    },
  )
})

describe('todayIsoDate', () => {
  it('is the local calendar date as YYYY-MM-DD', () => {
    expect(todayIsoDate(local(2026, 1, 5, 0, 30))).toBe('2026-01-05')
    expect(todayIsoDate(local(2026, 11, 10, 23, 59))).toBe('2026-11-10')
  })
})

describe('buildDueAt', () => {
  it('today / tomorrow at the given local time', () => {
    expect(buildDueAt({ day: 'today', time: '16:30', repeat: 'none' }, NOW)).toEqual({ dueAt: local(2026, 11, 10, 16, 30) })
    expect(buildDueAt({ day: 'tomorrow', time: '9:00', repeat: 'none' }, NOW)).toEqual({ dueAt: local(2026, 11, 11, 9, 0) })
  })

  it('other day uses the picked date', () => {
    expect(buildDueAt({ day: 'other', date: '2026-12-24', time: '20:00', repeat: 'none' }, NOW)).toEqual({
      dueAt: local(2026, 12, 24, 20, 0),
    })
  })

  it('rejects a bad time before anything else', () => {
    expect(buildDueAt({ day: 'today', time: '25:00', repeat: 'none' }, NOW)).toEqual({ error: 'time' })
    expect(buildDueAt({ day: 'today', time: '', repeat: 'daily' }, NOW)).toEqual({ error: 'time' })
  })

  it('rejects a missing or malformed date for other day', () => {
    expect(buildDueAt({ day: 'other', time: '10:00', repeat: 'none' }, NOW)).toEqual({ error: 'date' })
    expect(buildDueAt({ day: 'other', date: '', time: '10:00', repeat: 'none' }, NOW)).toEqual({ error: 'date' })
    expect(buildDueAt({ day: 'other', date: '2026-02-30', time: '10:00', repeat: 'none' }, NOW)).toEqual({ error: 'date' })
  })

  it('rejects a one-off time at or before now', () => {
    expect(buildDueAt({ day: 'today', time: '16:07', repeat: 'none' }, NOW)).toEqual({ error: 'past' })
    expect(buildDueAt({ day: 'today', time: '9:00', repeat: 'none' }, NOW)).toEqual({ error: 'past' })
    expect(buildDueAt({ day: 'other', date: '2026-11-09', time: '20:00', repeat: 'none' }, NOW)).toEqual({ error: 'past' })
  })

  it('repeating ignores the day and returns the next occurrence of the wall time', () => {
    expect(buildDueAt({ day: 'other', time: '9:00', repeat: 'daily' }, NOW)).toEqual({ dueAt: local(2026, 11, 11, 9, 0) })
    expect(buildDueAt({ day: 'today', time: '18:00', repeat: 'daily' }, NOW)).toEqual({ dueAt: local(2026, 11, 10, 18, 0) })
    // Friday 13 Nov 18:00 → Monday 16 Nov 09:00.
    expect(buildDueAt({ day: 'today', time: '09:00', repeat: 'weekdays' }, local(2026, 11, 13, 18, 0))).toEqual({
      dueAt: local(2026, 11, 16, 9, 0),
    })
  })

  it('is DST-safe: a skipped wall time resolves to the first valid instant after the gap', () => {
    // Europe/Madrid springs forward on Sunday 29 March 2026 at 02:00 → 03:00.
    const before = local(2026, 3, 28, 20, 0)
    const result = buildDueAt({ day: 'tomorrow', time: '02:30', repeat: 'none' }, before)
    expect(result).toEqual({ dueAt: local(2026, 3, 29, 3, 0) })
    // Fall back on 25 October 2026: 10:00 the next day is still 10:00 local.
    expect(buildDueAt({ day: 'tomorrow', time: '10:00', repeat: 'none' }, local(2026, 10, 24, 12, 0))).toEqual({
      dueAt: local(2026, 10, 25, 10, 0),
    })
  })
})
