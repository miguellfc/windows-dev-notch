import { describe, expect, it } from 'vitest'
import {
  REMINDERS_ACTIVE_MAX,
  REMINDER_TEXT_MAX,
  createReminderInputSchema,
  reminderPresetSchema,
  reminderSchema,
  reminderTextSchema,
  remindersFileSchema,
  updateReminderInputSchema,
} from '../../../src/shared/reminders/schema'

const id = '3f2b8c1e-4d5a-4e6f-8a9b-0c1d2e3f4a5b'
const base = {
  id,
  text: 'Call Ana',
  dueAt: '2026-11-11T09:00:00.000Z',
  repeat: 'none' as const,
  state: 'pending' as const,
  createdAt: '2026-11-10T10:00:00.000Z',
}

describe('constants', () => {
  it('exposes the limits', () => {
    expect(REMINDER_TEXT_MAX).toBe(200)
    expect(REMINDERS_ACTIVE_MAX).toBe(500)
  })
})

describe('reminderTextSchema', () => {
  it('trims and accepts 1-200 characters', () => {
    expect(reminderTextSchema.parse('  hello  ')).toBe('hello')
    expect(reminderTextSchema.safeParse('a'.repeat(200)).success).toBe(true)
  })

  it('rejects empty, blank and 201-character text', () => {
    expect(reminderTextSchema.safeParse('').success).toBe(false)
    expect(reminderTextSchema.safeParse('   ').success).toBe(false)
    expect(reminderTextSchema.safeParse('a'.repeat(201)).success).toBe(false)
  })

  it('rejects control and format characters', () => {
    // U+202E right-to-left override, U+200B zero-width space, U+2066 left-to-right isolate, U+FEFF BOM.
    for (const text of ['a\nb', 'a\tb', 'a\u0000b', 'a\u202Eb', 'a\u200Bb', 'a\u2066b', 'a\uFEFFb']) {
      expect(reminderTextSchema.safeParse(text).success, JSON.stringify(text)).toBe(false)
    }
  })

  it('allows the zero-width joiner of emoji sequences', () => {
    // Woman technologist: U+1F469 U+200D U+1F4BB.
    const text = '\u{1F469}\u200D\u{1F4BB} deploy'
    expect(reminderTextSchema.safeParse(text).success).toBe(true)
    // A ZWJ never excuses a neighbouring bidi override.
    expect(reminderTextSchema.safeParse('\u200D\u202Edeploy').success).toBe(false)
  })
})

describe('reminderSchema', () => {
  it('accepts a one-shot reminder with or without localTime', () => {
    expect(reminderSchema.safeParse(base).success).toBe(true)
    expect(reminderSchema.safeParse({ ...base, localTime: '09:00' }).success).toBe(true)
  })

  it('requires localTime for daily and weekdays', () => {
    expect(reminderSchema.safeParse({ ...base, repeat: 'daily' }).success).toBe(false)
    expect(reminderSchema.safeParse({ ...base, repeat: 'weekdays' }).success).toBe(false)
    expect(reminderSchema.safeParse({ ...base, repeat: 'daily', localTime: '08:30' }).success).toBe(true)
  })

  it('rejects malformed localTime', () => {
    for (const localTime of ['24:00', '9:00', '09:60', '0900']) {
      expect(reminderSchema.safeParse({ ...base, localTime }).success, localTime).toBe(false)
    }
  })

  it('rejects bad ids, dates, states and unknown keys', () => {
    expect(reminderSchema.safeParse({ ...base, id: 'nope' }).success).toBe(false)
    expect(reminderSchema.safeParse({ ...base, dueAt: 'tomorrow' }).success).toBe(false)
    expect(reminderSchema.safeParse({ ...base, state: 'later' }).success).toBe(false)
    expect(reminderSchema.safeParse({ ...base, extra: 1 }).success).toBe(false)
  })

  it('accepts completedAt as ISO datetime', () => {
    expect(
      reminderSchema.safeParse({ ...base, state: 'done', completedAt: '2026-11-11T09:01:00.000Z' }).success,
    ).toBe(true)
    expect(reminderSchema.safeParse({ ...base, completedAt: 'x' }).success).toBe(false)
  })
})

describe('remindersFileSchema', () => {
  it('accepts version 1 with reminders', () => {
    expect(remindersFileSchema.safeParse({ version: 1, reminders: [base] }).success).toBe(true)
    expect(remindersFileSchema.safeParse({ version: 2, reminders: [] }).success).toBe(false)
  })
})

describe('reminderPresetSchema', () => {
  it('accepts only the three chips', () => {
    for (const p of ['15m', '1h', 'tomorrow-9']) expect(reminderPresetSchema.safeParse(p).success).toBe(true)
    expect(reminderPresetSchema.safeParse('2h').success).toBe(false)
  })
})

describe('createReminderInputSchema', () => {
  it('accepts free-text input or text plus preset', () => {
    expect(createReminderInputSchema.safeParse({ input: 'call Ana in 10 min' }).success).toBe(true)
    expect(createReminderInputSchema.safeParse({ text: 'Call Ana', preset: '1h' }).success).toBe(true)
  })

  it('rejects over-long input, bad text, mixed and unknown keys', () => {
    expect(createReminderInputSchema.safeParse({ input: 'a'.repeat(401) }).success).toBe(false)
    expect(createReminderInputSchema.safeParse({ text: 'a\nb', preset: '1h' }).success).toBe(false)
    expect(createReminderInputSchema.safeParse({ input: 'x', preset: '1h' }).success).toBe(false)
    expect(createReminderInputSchema.safeParse({ text: 'x' }).success).toBe(false)
  })
})

describe('updateReminderInputSchema', () => {
  it('rejects an update with only an id', () => {
    expect(updateReminderInputSchema.safeParse({ id }).success).toBe(false)
  })

  it('accepts id plus at least one field', () => {
    expect(updateReminderInputSchema.safeParse({ id, text: 'New' }).success).toBe(true)
    expect(updateReminderInputSchema.safeParse({ id, dueAt: '2026-11-12T09:00:00.000Z' }).success).toBe(true)
    expect(updateReminderInputSchema.safeParse({ id, repeat: 'daily' }).success).toBe(true)
  })

  it('rejects invalid fields and unknown keys', () => {
    expect(updateReminderInputSchema.safeParse({ id, text: '' }).success).toBe(false)
    expect(updateReminderInputSchema.safeParse({ id: 'x', text: 'a' }).success).toBe(false)
    expect(updateReminderInputSchema.safeParse({ id, text: 'a', state: 'done' }).success).toBe(false)
  })
})
