import { z } from 'zod'
import { hasVisibleText } from '../text'

export const NOTE_TEXT_MAX = 2000
export const NOTES_MAX = 500
/** INVALID_INPUT message when creating or restoring would exceed NOTES_MAX; the notch maps it to its own copy. */
export const NOTE_LIMIT_MESSAGE = `Note limit reached (${NOTES_MAX})`

/**
 * Control (Cc) and format (Cf) characters except line breaks and tabs (notes are multiline)
 * and U+200D (zero-width joiner, needed by emoji sequences).
 */
const FORBIDDEN_CHARS = /(?![\n\r\t‍])[\p{Cc}\p{Cf}]/u

export const noteTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(NOTE_TEXT_MAX)
  .refine((text) => !FORBIDDEN_CHARS.test(text), 'Text contains control characters')
  .refine(hasVisibleText, 'Text has no visible characters')

export const noteSchema = z.strictObject({
  id: z.uuid(),
  text: noteTextSchema,
  pinned: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type Note = z.infer<typeof noteSchema>

export const notesFileSchema = z.strictObject({
  version: z.literal(1),
  notes: z.array(noteSchema),
})
export type NotesFile = z.infer<typeof notesFileSchema>

export const createNoteInputSchema = z.strictObject({ text: noteTextSchema })
export type CreateNoteInput = z.infer<typeof createNoteInputSchema>

export const updateNoteInputSchema = z.strictObject({ id: z.uuid(), text: noteTextSchema })
export type UpdateNoteInput = z.infer<typeof updateNoteInputSchema>

export const pinNoteInputSchema = z.strictObject({ id: z.uuid(), pinned: z.boolean() })
export type PinNoteInput = z.infer<typeof pinNoteInputSchema>

export const noteIdInputSchema = z.strictObject({ id: z.uuid() })
export type NoteIdInput = z.infer<typeof noteIdInputSchema>
