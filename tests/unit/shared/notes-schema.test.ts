import { describe, expect, it } from 'vitest'
import {
  NOTES_MAX,
  NOTE_TEXT_MAX,
  createNoteInputSchema,
  noteIdInputSchema,
  noteSchema,
  noteTextSchema,
  notesFileSchema,
  pinNoteInputSchema,
  updateNoteInputSchema,
} from '../../../src/shared/notes/schema'

const id = '3f2b8c1e-4d5a-4e6f-8a9b-0c1d2e3f4a5b'
const note = {
  id,
  text: 'Buy milk',
  pinned: false,
  createdAt: '2026-11-10T10:00:00.000Z',
  updatedAt: '2026-11-10T10:00:00.000Z',
}

describe('constants', () => {
  it('exposes the limits', () => {
    expect(NOTE_TEXT_MAX).toBe(2000)
    expect(NOTES_MAX).toBe(500)
  })
})

describe('noteTextSchema', () => {
  it('enforces 1..2000 chars after trimming', () => {
    expect(noteTextSchema.safeParse('a').success).toBe(true)
    expect(noteTextSchema.safeParse('a'.repeat(2000)).success).toBe(true)
    expect(noteTextSchema.safeParse('a'.repeat(2001)).success).toBe(false)
    expect(noteTextSchema.safeParse(`  ${'a'.repeat(2000)}  `).success).toBe(true)
    expect(noteTextSchema.safeParse('').success).toBe(false)
  })

  it('trims', () => {
    expect(noteTextSchema.parse('  hi  ')).toBe('hi')
  })

  it('rejects text without visible characters', () => {
    for (const bad of ['   ', '\n\n \t', '‍', ' ‍ \n']) {
      expect(noteTextSchema.safeParse(bad).success).toBe(false)
    }
  })

  it('accepts multiline text and emoji ZWJ sequences', () => {
    expect(noteTextSchema.parse('line 1\nline 2\r\n\tline 3')).toBe('line 1\nline 2\r\n\tline 3')
    expect(noteTextSchema.safeParse('\u{1F469}‍\u{1F4BB}').success).toBe(true)
  })

  it('rejects other control and format characters', () => {
    expect(noteTextSchema.safeParse('a\u0000b').success).toBe(false)
    expect(noteTextSchema.safeParse('a‮b').success).toBe(false)
    expect(noteTextSchema.safeParse('a​b').success).toBe(false)
  })
})

describe('noteSchema / notesFileSchema', () => {
  it('accepts a valid note and rejects unknown keys', () => {
    expect(noteSchema.safeParse(note).success).toBe(true)
    expect(noteSchema.safeParse({ ...note, extra: 1 }).success).toBe(false)
    expect(noteSchema.safeParse({ ...note, id: 'nope' }).success).toBe(false)
    expect(noteSchema.safeParse({ ...note, createdAt: 'yesterday' }).success).toBe(false)
  })

  it('validates the file envelope', () => {
    expect(notesFileSchema.safeParse({ version: 1, notes: [note] }).success).toBe(true)
    expect(notesFileSchema.safeParse({ version: 2, notes: [] }).success).toBe(false)
    expect(notesFileSchema.safeParse({ version: 1, notes: [], extra: 1 }).success).toBe(false)
  })
})

describe('input schemas', () => {
  it('create', () => {
    expect(createNoteInputSchema.parse({ text: ' x ' })).toEqual({ text: 'x' })
    expect(createNoteInputSchema.safeParse({ text: 'x', extra: 1 }).success).toBe(false)
  })
  it('update', () => {
    expect(updateNoteInputSchema.safeParse({ id, text: 'x' }).success).toBe(true)
    expect(updateNoteInputSchema.safeParse({ id: 'nope', text: 'x' }).success).toBe(false)
    expect(updateNoteInputSchema.safeParse({ id }).success).toBe(false)
  })
  it('pin', () => {
    expect(pinNoteInputSchema.safeParse({ id, pinned: true }).success).toBe(true)
    expect(pinNoteInputSchema.safeParse({ id, pinned: 'yes' }).success).toBe(false)
  })
  it('id', () => {
    expect(noteIdInputSchema.safeParse({ id }).success).toBe(true)
    expect(noteIdInputSchema.safeParse({ id, x: 1 }).success).toBe(false)
  })
})
