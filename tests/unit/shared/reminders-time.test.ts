import { describe, expect, it } from 'vitest'
import { atLocalTime, nextOccurrence, presetDueAt, startOfLocalDay } from '../../../src/shared/reminders/time'

const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date =>
  new Date(y, mo - 1, d, h, mi, s)

describe('timezone setup', () => {
  it('runs in Europe/Madrid', () => {
    expect(new Date(2026, 0, 15, 12).getTimezoneOffset()).toBe(-60)
    expect(new Date(2026, 6, 15, 12).getTimezoneOffset()).toBe(-120)
  })
})

describe('atLocalTime', () => {
  it('uses the local calendar date of the given day', () => {
    expect(atLocalTime(local(2026, 11, 10, 23, 59), '09:05')).toEqual(local(2026, 11, 10, 9, 5))
  })

  it('moves a nonexistent spring-forward time to the first valid instant after the gap', () => {
    expect(atLocalTime(local(2026, 3, 29, 12), '02:30')).toEqual(local(2026, 3, 29, 3, 0))
  })

  it('uses the first occurrence on fall-back', () => {
    const d = atLocalTime(local(2026, 10, 25, 12), '02:30')
    expect(d.getTimezoneOffset()).toBe(-120)
    expect(d.getHours()).toBe(2)
    expect(d.getMinutes()).toBe(30)
  })
})

describe('nextOccurrence', () => {
  it('daily: later today when still ahead', () => {
    expect(nextOccurrence('daily', '09:00', local(2026, 11, 10, 8, 0))).toEqual(
      local(2026, 11, 10, 9, 0),
    )
  })

  it('daily: strictly after, equal counts as past', () => {
    expect(nextOccurrence('daily', '09:00', local(2026, 11, 10, 9, 0))).toEqual(
      local(2026, 11, 11, 9, 0),
    )
  })

  it('weekdays: Friday 10:00 -> Monday 09:30', () => {
    expect(nextOccurrence('weekdays', '09:30', local(2026, 11, 13, 10, 0))).toEqual(
      local(2026, 11, 16, 9, 30),
    )
  })

  it('weekdays: Saturday -> Monday', () => {
    expect(nextOccurrence('weekdays', '09:30', local(2026, 11, 14, 7, 0))).toEqual(
      local(2026, 11, 16, 9, 30),
    )
  })

  it('daily 02:30 on the spring-forward day fires at 03:00', () => {
    expect(nextOccurrence('daily', '02:30', local(2026, 3, 29, 0, 10))).toEqual(
      local(2026, 3, 29, 3, 0),
    )
  })

  it('daily 02:30 on the fall-back day fires once', () => {
    const first = nextOccurrence('daily', '02:30', local(2026, 10, 25, 0, 10))
    expect(first.getTimezoneOffset()).toBe(-120)
    expect(first.getHours()).toBe(2)
    const second = nextOccurrence('daily', '02:30', first)
    expect(second).toEqual(local(2026, 10, 26, 2, 30))
  })
})

describe('nextOccurrence pinning', () => {
  it('daily 02:30 returns to 02:30 the day after the spring-forward gap', () => {
    expect(nextOccurrence('daily', '02:30', local(2026, 3, 29, 3, 0))).toEqual(
      local(2026, 3, 30, 2, 30),
    )
  })

  it('weekdays starting on Sunday -> Monday', () => {
    expect(nextOccurrence('weekdays', '09:30', local(2026, 11, 15, 8, 0))).toEqual(
      local(2026, 11, 16, 9, 30),
    )
  })

  it('weekdays on Friday before the time -> same Friday', () => {
    expect(nextOccurrence('weekdays', '09:30', local(2026, 11, 13, 8, 0))).toEqual(
      local(2026, 11, 13, 9, 30),
    )
  })

  it('daily rolls over the year boundary', () => {
    expect(nextOccurrence('daily', '09:00', local(2026, 12, 31, 10, 0))).toEqual(
      local(2027, 1, 1, 9, 0),
    )
  })
})

describe('presetDueAt', () => {
  const now = local(2026, 11, 10, 15, 0, 20)
  it('15m and 1h add minutes to now', () => {
    expect(presetDueAt('15m', now).getTime()).toBe(now.getTime() + 15 * 60_000)
    expect(presetDueAt('1h', now).getTime()).toBe(now.getTime() + 60 * 60_000)
  })
  it('tomorrow-9 is tomorrow 09:00 local', () => {
    expect(presetDueAt('tomorrow-9', now)).toEqual(local(2026, 11, 11, 9, 0))
  })
})

describe('startOfLocalDay', () => {
  it('returns local midnight, shifting whole days across month and year ends', () => {
    expect(startOfLocalDay(local(2026, 12, 31, 18, 30))).toEqual(local(2026, 12, 31))
    expect(startOfLocalDay(local(2026, 12, 31, 18, 30), 1)).toEqual(local(2027, 1, 1))
    expect(startOfLocalDay(local(2026, 1, 31, 18, 30), 1)).toEqual(local(2026, 2, 1))
  })
})
