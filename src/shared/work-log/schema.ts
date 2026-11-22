import { z } from 'zod'

/** Longest subtask title the view carries. */
export const WORK_LOG_SUBTASK_TITLE_MAX = 300

const nonNegativeMs = z.number().nonnegative()

/**
 * One subtask of a summarized session. A `done` one carries the time Claude worked on it and the
 * wall-clock time; a `pending` one has no time yet (both `null`), or a partial one while it is
 * still being worked on.
 */
export const workLogSubtaskViewSchema = z
  .strictObject({
    title: z.string().min(1).max(WORK_LOG_SUBTASK_TITLE_MAX),
    status: z.enum(['done', 'pending']),
    claudeMs: nonNegativeMs.nullable(),
    totalMs: nonNegativeMs.nullable(),
  })
  .refine((subtask) => subtask.status !== 'done' || (subtask.claudeMs !== null && subtask.totalMs !== null), 'A done subtask needs both durations')
export type WorkLogSubtaskView = z.infer<typeof workLogSubtaskViewSchema>

/** Where a session's record is: ticking, paused by idleness, being summarized, waiting for a summary, or ready. */
export const workLogStatusSchema = z.enum(['running', 'paused', 'summarizing', 'unsummarized', 'ready'])
export type WorkLogStatus = z.infer<typeof workLogStatusSchema>

/**
 * What the work log view needs to draw a running or paused session's clock. `waitSince`: since when
 * the open turn waits for the user (a permission, a question); that wait counts in the total only
 * up to the idle pause.
 */
export const workLogLiveSchema = z.strictObject({
  lastEventAt: z.number().nonnegative(),
  excessMs: nonNegativeMs,
  turnOpen: z.boolean(),
  waitSince: z.number().nonnegative().nullable(),
})
export type WorkLogLive = z.infer<typeof workLogLiveSchema>

/** A session as the work log shows it (`title` is the summary's, or the provisional one before it exists). `live` only comes with a running or paused one. */
export const workLogEntryViewSchema = z
  .strictObject({
    sessionId: z.string().min(1).max(256),
    accountId: z.string().min(1).max(256),
    project: z.string().max(512),
    status: workLogStatusSchema,
    invoiced: z.boolean(),
    startedAt: z.number().nonnegative(),
    endedAt: z.number().nonnegative().nullable(),
    claudeMs: nonNegativeMs,
    totalMs: nonNegativeMs,
    live: workLogLiveSchema.nullable(),
    title: z.string().max(512),
    subtasks: z.array(workLogSubtaskViewSchema),
  })
  .refine((entry) => entry.live === null || entry.status === 'running' || entry.status === 'paused', 'live only comes with a running or paused entry')
export type WorkLogEntryView = z.infer<typeof workLogEntryViewSchema>

/** Every entry (newest first) and the idle pause in force, in ms; output of `work-log:list` and payload of `work-log:changed`. */
export const workLogSnapshotSchema = z.strictObject({
  entries: z.array(workLogEntryViewSchema),
  idlePauseMs: z.number().nonnegative(),
})
export type WorkLogSnapshot = z.infer<typeof workLogSnapshotSchema>

export const workLogSessionInputSchema = z.strictObject({ sessionId: z.string().min(1).max(256) })
export type WorkLogSessionInput = z.infer<typeof workLogSessionInputSchema>

export const workLogSetInvoicedInputSchema = z.strictObject({ sessionId: z.string().min(1).max(256), invoiced: z.boolean() })
export type WorkLogSetInvoicedInput = z.infer<typeof workLogSetInvoicedInputSchema>

/** `subtask`: position of the subtask to copy; without it, the whole session. */
export const workLogCopyInputSchema = z.strictObject({ sessionId: z.string().min(1).max(256), subtask: z.int().min(0).max(1000).optional() })
export type WorkLogCopyInput = z.infer<typeof workLogCopyInputSchema>

export const workLogClaudeAvailableSchema = z.strictObject({ found: z.boolean() })
export type WorkLogClaudeAvailable = z.infer<typeof workLogClaudeAvailableSchema>
