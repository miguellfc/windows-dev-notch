import { describe, expect, it } from 'vitest'
import { NOTE_LIMIT_MESSAGE, NOTE_TEXT_MAX } from '../../../src/shared/notes/schema'
import { formatEdited, noteErrorKey, noteLabel, thrownNoteErrorKey, undoErrorKey, validateNoteText } from '../../../src/renderer/shared/notes/format'

const NOW = new Date(2026, 10, 11, 12, 0) // Wednesday 11 November 2026, 12:00 local
const ago = (ms: number): Date => new Date(NOW.getTime() - ms)
const MIN = 60_000

describe('formatEdited', () => {
  it('says "now" under a minute, and for a time slightly in the future (clock skew)', () => {
    expect(formatEdited(ago(30_000), NOW, 'es')).toBe('ahora')
    expect(formatEdited(ago(0), NOW, 'en')).toBe('just now')
    expect(formatEdited(ago(-90_000), NOW, 'es')).toBe('ahora')
  })

  it('counts whole minutes under an hour', () => {
    expect(formatEdited(ago(3 * MIN + 20_000), NOW, 'es')).toBe('hace 3 min')
    expect(formatEdited(ago(3 * MIN), NOW, 'en')).toMatch(/^3 min\.? ago$/)
    expect(formatEdited(ago(59 * MIN), NOW, 'es')).toBe('hace 59 min')
  })

  it('counts whole hours under a day', () => {
    expect(formatEdited(ago(60 * MIN), NOW, 'es')).toBe('hace 1 h')
    expect(formatEdited(ago(5 * 60 * MIN + 59 * MIN), NOW, 'es')).toBe('hace 5 h')
    expect(formatEdited(ago(2 * 60 * MIN), NOW, 'en')).toMatch(/^2 hr\.? ago$/)
  })

  it('counts days under a week, with "yesterday" for one', () => {
    expect(formatEdited(ago(24 * 60 * MIN), NOW, 'es')).toBe('ayer')
    expect(formatEdited(ago(24 * 60 * MIN), NOW, 'en')).toBe('yesterday')
    expect(formatEdited(ago(3 * 24 * 60 * MIN), NOW, 'es')).toBe('hace 3 d')
  })

  it('shows the day and month from a week on, and the year when it differs', () => {
    expect(formatEdited(new Date(2026, 10, 2, 9, 0), NOW, 'es')).toBe('2 nov')
    expect(formatEdited(new Date(2026, 10, 2, 9, 0), NOW, 'en')).toBe('Nov 2')
    expect(formatEdited(new Date(2025, 10, 2, 9, 0), NOW, 'es')).toMatch(/2025/)
  })
})

describe('noteLabel', () => {
  it('uses the first non-blank line, trimmed', () => {
    expect(noteLabel('\n  Comprar pan  \nleche')).toBe('Comprar pan')
  })

  it('cuts a long first line with an ellipsis', () => {
    const label = noteLabel('a'.repeat(100))
    expect(label).toHaveLength(41)
    expect(label.endsWith('…')).toBe(true)
  })
})

describe('validateNoteText', () => {
  it('rejects blank and whitespace-only text', () => {
    expect(validateNoteText('')).toBe('notes.error.empty')
    expect(validateNoteText('  \n\t \n ')).toBe('notes.error.empty')
    expect(validateNoteText('​‍')).toBe('notes.error.empty')
  })

  it('accepts up to the limit after trimming, and rejects one more', () => {
    expect(validateNoteText(`  ${'x'.repeat(NOTE_TEXT_MAX)}  \n`)).toBeNull()
    expect(validateNoteText('x'.repeat(NOTE_TEXT_MAX + 1))).toBe('notes.error.tooLong')
  })

  it('accepts multiline text', () => {
    expect(validateNoteText('línea 1\nlínea 2')).toBeNull()
  })
})

describe('noteErrorKey', () => {
  it('maps read-only, gone and the limit; everything else is generic', () => {
    expect(noteErrorKey({ code: 'READ_ONLY', message: 'x' })).toBe('notes.notice.readOnly')
    expect(noteErrorKey({ code: 'NOT_FOUND', message: 'x' })).toBe('notes.error.notFound')
    expect(noteErrorKey({ code: 'INVALID_INPUT', message: NOTE_LIMIT_MESSAGE })).toBe('notes.error.limit')
    expect(noteErrorKey({ code: 'INVALID_INPUT', message: 'Invalid note text' })).toBe('error.generic')
    expect(noteErrorKey({ code: 'INTERNAL', message: 'x' })).toBe('error.generic')
  })
})

describe('undoErrorKey', () => {
  it('says read-only for READ_ONLY and "could not undo" otherwise', () => {
    expect(undoErrorKey({ code: 'READ_ONLY', message: 'x' })).toBe('notes.notice.readOnly')
    expect(undoErrorKey({ code: 'NOT_FOUND', message: 'x' })).toBe('notes.undo.failed')
    expect(undoErrorKey({ code: 'INTERNAL', message: 'x' })).toBe('notes.undo.failed')
  })
})

describe('thrownNoteErrorKey', () => {
  it('maps a READ_ONLY error to the read-only text and anything else to the fallback', () => {
    expect(thrownNoteErrorKey({ code: 'READ_ONLY', message: 'x' }, 'error.generic')).toBe('notes.notice.readOnly')
    expect(thrownNoteErrorKey({ code: 'READ_ONLY', message: 'x' }, 'notes.undo.failed')).toBe('notes.notice.readOnly')
    expect(thrownNoteErrorKey(new Error('boom'), 'error.generic')).toBe('error.generic')
    expect(thrownNoteErrorKey(null, 'notes.undo.failed')).toBe('notes.undo.failed')
    expect(thrownNoteErrorKey({ code: 'NOT_FOUND', message: 'x' }, 'error.generic')).toBe('error.generic')
  })
})

