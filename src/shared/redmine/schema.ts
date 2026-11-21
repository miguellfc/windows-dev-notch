import { z } from 'zod'
import { localDate } from '../code-review/contributions'
import { REDMINE_URL_MAX } from './url'

/** A Redmine API key is never longer than this. */
export const REDMINE_KEY_MAX = 255
export const REDMINE_COMMENT_MAX = 255
const TEXT_MAX = 512

export const redmineStatusSchema = z.enum(['unconfigured', 'ok', 'offline', 'auth-error'])
export type RedmineStatus = z.infer<typeof redmineStatusSchema>

export const redmineStateSchema = z.strictObject({
  status: redmineStatusSchema,
  account: z.string().max(TEXT_MAX).nullable(),
  /** Hours logged today; `null` until the first read. */
  todayHours: z.number().min(0).nullable(),
  /** Hours logged from the 1st of the current month to today; `null` until the first read. */
  monthHours: z.number().min(0).nullable(),
  updatedAt: z.number().nullable(),
  /** Whether the API key is stored encrypted on disk (false: memory only). */
  persistent: z.boolean(),
})
export type RedmineState = z.infer<typeof redmineStateSchema>

const textSchema = z.string().max(TEXT_MAX)
const namedSchema = z.strictObject({ id: z.int(), name: textSchema })

export const redmineIssueSchema = z.strictObject({
  id: z.int().min(1),
  subject: textSchema,
  project: textSchema,
  status: namedSchema,
  estimatedHours: z.number().min(0).nullable(),
  spentHours: z.number().min(0).nullable(),
  /** ISO time of the last update. */
  updatedOn: textSchema,
})
export type RedmineIssue = z.infer<typeof redmineIssueSchema>

export const redmineIssueListSchema = z.strictObject({
  issues: z.array(redmineIssueSchema),
  truncated: z.boolean(),
})
export type RedmineIssueList = z.infer<typeof redmineIssueListSchema>

export const redmineIssueDetailSchema = redmineIssueSchema.extend({ allowedStatuses: z.array(namedSchema) })
export type RedmineIssueDetail = z.infer<typeof redmineIssueDetailSchema>

export const redmineActivitySchema = z.strictObject({ id: z.int(), name: textSchema, isDefault: z.boolean() })
export type RedmineActivity = z.infer<typeof redmineActivitySchema>

const dayKeySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)

export const redmineSummarySchema = z.strictObject({
  /** `YYYY-MM`. */
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  days: z.array(z.strictObject({ date: dayKeySchema, hours: z.number().min(0) })),
  today: z.number().min(0),
  week: z.number().min(0),
  monthTotal: z.number().min(0),
})
export type RedmineSummary = z.infer<typeof redmineSummarySchema>

export const redmineWriteErrorSchema = z.enum([
  'auth',
  'forbidden',
  'not-found',
  'validation',
  'network',
  'server',
  'invalid-response',
])
export type RedmineWriteError = z.infer<typeof redmineWriteErrorSchema>

export const redmineWriteResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({
    ok: z.literal(false),
    reason: redmineWriteErrorSchema,
    /** Redmine's validation messages (trimmed to 200 chars, at most 3). */
    messages: z.array(z.string().max(200)).max(3).optional(),
  }),
])
export type RedmineWriteResult = z.infer<typeof redmineWriteResultSchema>

export const redmineSetKeyResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), account: textSchema }),
  z.strictObject({ ok: z.literal(false), reason: z.enum(['auth', 'network', 'url']) }),
])
export type RedmineSetKeyResult = z.infer<typeof redmineSetKeyResultSchema>

/** End-of-day alert payload: hours logged today versus the daily target. */
export const redmineAlertSchema = z.strictObject({ hours: z.number().min(0), target: z.number().min(1).max(24) })
export type RedmineAlert = z.infer<typeof redmineAlertSchema>

// IPC inputs.
/** At most 2 decimals (hundredths), tolerant to float noise such as 1.1 * 100. */
const hasMax2Decimals = (value: number): boolean => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6

const hoursSchema = z.number().gt(0).max(24).refine(hasMax2Decimals, 'At most 2 decimals')

export const updateIssueInputSchema = z
  .strictObject({
    id: z.int().min(1),
    statusId: z.int().min(1).optional(),
    /** `null` clears the estimate. */
    estimatedHours: z.number().min(0).max(999).refine(hasMax2Decimals, 'At most 2 decimals').nullable().optional(),
  })
  .refine((input) => input.statusId !== undefined || input.estimatedHours !== undefined, 'Nothing to update')
export type UpdateIssueInput = z.infer<typeof updateIssueInputSchema>

export const logTimeInputSchema = z.strictObject({
  issueId: z.int().min(1),
  /** Local date `YYYY-MM-DD`, not in the future. */
  spentOn: dayKeySchema.refine((day) => day <= localDate(new Date()), 'Date cannot be in the future'),
  hours: hoursSchema,
  activityId: z.int().min(1),
  comments: z.string().max(REDMINE_COMMENT_MAX),
})
export type LogTimeInput = z.infer<typeof logTimeInputSchema>

export const setKeyInputSchema = z.strictObject({
  /** Server URL as typed (validated and normalized in main). */
  url: z.string().max(REDMINE_URL_MAX),
  key: z.string().min(1).max(REDMINE_KEY_MAX),
})
export type SetKeyInput = z.infer<typeof setKeyInputSchema>

/** One issue by its Redmine id (the renderer never sends a URL). */
export const redmineIdInputSchema = z.strictObject({ id: z.int().min(1) })
export type RedmineIdInput = z.infer<typeof redmineIdInputSchema>

/** Output of `redmine:find-issue`: false for an issue that does not exist or the key cannot see. */
export const redmineFindIssueResultSchema = z.strictObject({ found: z.boolean() })
export type RedmineFindIssueResult = z.infer<typeof redmineFindIssueResultSchema>

/** The Redmine view opened or closed: the month summary is queried only while it is open. */
export const redmineViewInputSchema = z.strictObject({ open: z.boolean() })

/** The cached month summary (null when not connected or not loaded yet) and whether the last query failed. */
export const redmineSummaryResultSchema = z.strictObject({ summary: redmineSummarySchema.nullable(), error: z.boolean() })
export type RedmineSummaryResult = z.infer<typeof redmineSummaryResultSchema>

/** The summary changed or a query ended: the notch asks `redmine:summary` again. */
export const redmineSummaryChangedSchema = z.strictObject({ error: z.boolean() })
export type RedmineSummaryChanged = z.infer<typeof redmineSummaryChangedSchema>
