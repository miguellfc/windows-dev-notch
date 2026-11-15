import { z } from 'zod'

/** Ranges the Control Center can ask for, in days. */
export const USAGE_RANGES = [7, 14, 30] as const
export type UsageRange = (typeof USAGE_RANGES)[number]
export const DEFAULT_USAGE_RANGE: UsageRange = 14

/** Local calendar day, `YYYY-MM-DD`. */
export const dayKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const count = z.int().nonnegative()

/** Aggregates of the local usage log over the last N days (counts only, nothing personal). */
export const usageSummarySchema = z.strictObject({
  /** Days in the range with any running minutes or launches. */
  days: count,
  /** Running hours per used day (0 when no day was used). */
  runningHoursAvg: z.number().nonnegative(),
  launches: count,
  remindersFired: count,
  remindersMissed: count,
  remindersCompleted: count,
  claudeAlerts: count,
  claudeLatencyMedianMs: count.nullable(),
  claudeLatencyP95Ms: count.nullable(),
  from: dayKeySchema,
  to: dayKeySchema,
})

export type UsageSummary = z.infer<typeof usageSummarySchema>

export const usageSummaryInputSchema = z.strictObject({
  days: z.literal(USAGE_RANGES).optional(),
})
