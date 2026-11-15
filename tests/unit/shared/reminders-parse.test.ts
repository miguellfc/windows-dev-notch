import { describe, expect, it } from 'vitest'
import { parseReminder } from '../../../src/shared/reminders/parse'

const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date =>
  new Date(y, mo - 1, d, h, mi, s)

const NOW = local(2026, 11, 10, 12, 0, 0) // Tuesday

describe('parseReminder relative', () => {
  it.each([
    ['en 30 min revisar PR', 30, 'revisar PR'],
    ['in 30 min review PR', 30, 'review PR'],
    ['en 2 h llamar', 120, 'llamar'],
    ['in 1 hour call', 60, 'call'],
    ['en 5 minutos x', 5, 'x'],
    ['in 3 hours x', 180, 'x'],
    ['en 2h x', 120, 'x'],
    ['EN 5 MIN x', 5, 'x'],
  ])('%s', (input, minutes, text) => {
    expect(parseReminder(input, NOW)).toEqual({
      text,
      dueAt: new Date(NOW.getTime() + minutes * 60_000),
      repeat: 'none',
    })
  })

  it('rejects zero, fractions and > 7 days', () => {
    expect(parseReminder('en 0 min x', NOW)).toEqual({ error: 'no-time' })
    expect(parseReminder('en 1.5 h x', NOW)).toEqual({ error: 'no-time' })
    expect(parseReminder('en 10081 min x', NOW)).toEqual({ error: 'no-time' })
    expect(parseReminder('en 169 h x', NOW)).toEqual({ error: 'no-time' })
    expect(parseReminder('en 10080 min x', NOW)).toMatchObject({ repeat: 'none' })
  })
})

describe('parseReminder clock times', () => {
  it('16:00 today when 15:59, tomorrow when 16:00:00 or 16:00:30', () => {
    expect(parseReminder('16:00 standup', local(2026, 11, 10, 15, 59))).toEqual({
      text: 'standup',
      dueAt: local(2026, 11, 10, 16, 0),
      repeat: 'none',
    })
    expect(parseReminder('16:00 standup', local(2026, 11, 10, 16, 0, 0))).toMatchObject({
      dueAt: local(2026, 11, 11, 16, 0),
    })
    expect(parseReminder('16:00 standup', local(2026, 11, 10, 16, 0, 30))).toMatchObject({
      dueAt: local(2026, 11, 11, 16, 0),
    })
  })

  it('am/pm forms', () => {
    expect(parseReminder('4pm x', NOW)).toMatchObject({ dueAt: local(2026, 11, 10, 16, 0) })
    expect(parseReminder('4 PM x', NOW)).toMatchObject({ dueAt: local(2026, 11, 10, 16, 0) })
    expect(parseReminder('12am x', NOW)).toMatchObject({ dueAt: local(2026, 11, 11, 0, 0) })
    expect(parseReminder('12pm x', local(2026, 11, 10, 8))).toMatchObject({
      dueAt: local(2026, 11, 10, 12, 0),
    })
    expect(parseReminder('4:30pm x', NOW)).toMatchObject({ dueAt: local(2026, 11, 10, 16, 30) })
    expect(parseReminder('4:30 pm x', NOW)).toMatchObject({ dueAt: local(2026, 11, 10, 16, 30) })
  })

  it('optional "a las" / "at"', () => {
    expect(parseReminder('a las 16:00 x', NOW)).toMatchObject({
      text: 'x',
      dueAt: local(2026, 11, 10, 16, 0),
    })
    expect(parseReminder('at 4pm x', NOW)).toMatchObject({ dueAt: local(2026, 11, 10, 16, 0) })
  })

  it('tomorrow', () => {
    for (const input of [
      'mañana 9:00 x',
      'tomorrow 9:00 x',
      'Manana 9:00 x',
      'mañana a las 9:00 x',
    ]) {
      expect(parseReminder(input, NOW)).toEqual({
        text: 'x',
        dueAt: local(2026, 11, 11, 9, 0),
        repeat: 'none',
      })
    }
  })
})

describe('parseReminder rollover and normalization', () => {
  const NEW_YEARS_EVE = local(2026, 12, 31, 20, 0)

  it('mañana on Dec 31 is Jan 1', () => {
    expect(parseReminder('mañana 9:00 x', NEW_YEARS_EVE)).toMatchObject({
      dueAt: local(2027, 1, 1, 9, 0),
    })
  })

  it('a plain time already past on Dec 31 falls back to Jan 1', () => {
    expect(parseReminder('9:00 x', NEW_YEARS_EVE)).toEqual({
      text: 'x',
      dueAt: local(2027, 1, 1, 9, 0),
      repeat: 'none',
    })
  })

  it('parses decomposed accents (NFC normalization)', () => {
    expect(parseReminder('cada día 9:00 x', NOW)).toMatchObject({
      repeat: 'daily',
      dueAt: local(2026, 11, 11, 9, 0),
    })
    expect(parseReminder('mañana 9:00 x', NOW)).toMatchObject({
      dueAt: local(2026, 11, 11, 9, 0),
    })
  })
})

describe('parseReminder repeating', () => {
  it('daily', () => {
    for (const input of [
      'diario 9:00 x',
      'daily 9:00 x',
      'cada día 9:00 x',
      'cada dia 9:00 x',
      'every day 9:00 x',
    ]) {
      expect(parseReminder(input, NOW)).toEqual({
        text: 'x',
        dueAt: local(2026, 11, 11, 9, 0),
        repeat: 'daily',
        localTime: '09:00',
      })
    }
  })

  it('weekdays on Friday 10:00 -> Monday 09:30', () => {
    const friday = local(2026, 11, 13, 10, 0)
    for (const input of ['laborables 9:30 x', 'weekdays 9:30 x']) {
      expect(parseReminder(input, friday)).toEqual({
        text: 'x',
        dueAt: local(2026, 11, 16, 9, 30),
        repeat: 'weekdays',
        localTime: '09:30',
      })
    }
  })

  it('daily with am is zero-padded 24h', () => {
    expect(parseReminder('daily 9am x', NOW)).toMatchObject({ localTime: '09:00' })
  })
})

describe('parseReminder errors', () => {
  it('empty text', () => {
    expect(parseReminder('16:00', NOW)).toEqual({ error: 'empty-text' })
    expect(parseReminder('en 5 min   ', NOW)).toEqual({ error: 'empty-text' })
  })
  it('invisible-only text counts as empty', () => {
    expect(parseReminder('16:00 ‍', NOW)).toEqual({ error: 'empty-text' })
    expect(parseReminder('en 5 min ‍ ‍', NOW)).toEqual({ error: 'empty-text' })
  })
  it('no time', () => {
    expect(parseReminder('revisar PR', NOW)).toEqual({ error: 'no-time' })
    expect(parseReminder('', NOW)).toEqual({ error: 'no-time' })
    expect(parseReminder('25:00 x', NOW)).toEqual({ error: 'no-time' })
    expect(parseReminder('13pm x', NOW)).toEqual({ error: 'no-time' })
    expect(parseReminder('0am x', NOW)).toEqual({ error: 'no-time' })
    expect(parseReminder('16:60 x', NOW)).toEqual({ error: 'no-time' })
    expect(parseReminder('mañana x', NOW)).toEqual({ error: 'no-time' })
  })
  it('too long', () => {
    expect(parseReminder(`16:00 ${'a'.repeat(201)}`, NOW)).toEqual({ error: 'too-long' })
    expect(parseReminder(`16:00 ${'a'.repeat(200)}`, NOW)).toMatchObject({ repeat: 'none' })
  })
  it('returns control chars as-is (service validates)', () => {
    expect(parseReminder('16:00 a\tb', NOW)).toMatchObject({ text: 'a\tb' })
  })
})
