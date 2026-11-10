import { z } from 'zod'

export const REMINDER_TEXT_MAX = 200
export const REMINDERS_ACTIVE_MAX = 500

/** INVALID_INPUT message for an update whose dueAt is not in the future; main and renderer share it. */
export const REMINDER_PAST_MESSAGE = 'dueAt must be in the future'

/** INVALID_INPUT message for acting on a reminder that is already done; main and renderer share it. */
export const REMINDER_DONE_MESSAGE = 'Reminder is already done'

/**
 * Control (Cc) and format (Cf) characters, e.g. newlines, NUL, bidi overrides, zero-width spaces.
 * U+200D (zero-width joiner) is allowed: emoji sequences (woman + ZWJ + laptop) need it.
 */
const FORBIDDEN_CHARS = /(?!\u200D)[\p{Cc}\p{Cf}]/u

export const reminderTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(REMINDER_TEXT_MAX)
  .refine((text) => !FORBIDDEN_CHARS.test(text), 'Text contains control characters')

export const reminderRepeatSchema = z.enum(['none', 'daily', 'weekdays'])
export const reminderStateSchema = z.enum(['pending', 'due', 'missed', 'done'])

/** Wall-clock time `HH:mm`, 24 hours. */
export const localTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Invalid HH:mm time')

export const reminderSchema = z
  .strictObject({
    id: z.uuid(),
    text: reminderTextSchema,
    dueAt: z.iso.datetime(),
    repeat: reminderRepeatSchema,
    localTime: localTimeSchema.optional(),
    state: reminderStateSchema,
    createdAt: z.iso.datetime(),
    completedAt: z.iso.datetime().optional(),
  })
  .refine((r) => r.repeat === 'none' || r.localTime !== undefined, {
    message: 'localTime is required for repeating reminders',
    path: ['localTime'],
  })
export type Reminder = z.infer<typeof reminderSchema>

export const remindersFileSchema = z.strictObject({
  version: z.literal(1),
  reminders: z.array(reminderSchema),
})
export type RemindersFile = z.infer<typeof remindersFileSchema>

export const reminderPresetSchema = z.enum(['15m', '1h', 'tomorrow-9'])
export type ReminderPreset = z.infer<typeof reminderPresetSchema>

export const createReminderInputSchema = z.union([
  z.strictObject({ input: z.string().max(400) }),
  z.strictObject({ text: reminderTextSchema, preset: reminderPresetSchema }),
  /** The notch form: an explicit instant; for repeating reminders only its local HH:mm counts. */
  z.strictObject({ text: reminderTextSchema, dueAt: z.iso.datetime(), repeat: reminderRepeatSchema }),
])
export type CreateReminderInput = z.infer<typeof createReminderInputSchema>

export const updateReminderInputSchema = z
  .strictObject({
    id: z.uuid(),
    text: reminderTextSchema.optional(),
    dueAt: z.iso.datetime().optional(),
    repeat: reminderRepeatSchema.optional(),
  })
  .refine(
    (u) => u.text !== undefined || u.dueAt !== undefined || u.repeat !== undefined,
    'Update needs at least one field besides id',
  )
export type UpdateReminderInput = z.infer<typeof updateReminderInputSchema>
