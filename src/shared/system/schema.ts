import { z } from 'zod'

const percentSchema = z.number().min(0).max(100)
const bytesSchema = z.number().nonnegative()

export const lightSampleSchema = z.strictObject({
  cpuPercent: percentSchema.nullable(),
  ram: z.strictObject({ usedBytes: bytesSchema, totalBytes: bytesSchema }).nullable(),
  battery: z
    .strictObject({
      percent: percentSchema,
      charging: z.boolean(),
      /** On AC power (charging or full); `charging` alone is false at 100 % on AC. */
      pluggedIn: z.boolean(),
      secondsLeft: z.int().nonnegative().nullable(),
    })
    .nullable(),
})
export type LightSample = z.infer<typeof lightSampleSchema>

export const fullSampleSchema = lightSampleSchema.extend({
  disks: z.array(
    z.strictObject({
      letter: z.string().regex(/^[A-Z]$/),
      usedPercent: percentSchema,
      freeBytes: bytesSchema,
      activityPercent: percentSchema.nullable(),
    }),
  ),
  network: z.strictObject({ upBytesPerSec: bytesSchema, downBytesPerSec: bytesSchema }).nullable(),
})
export type FullSample = z.infer<typeof fullSampleSchema>

export const systemMetricsSchema = z.discriminatedUnion('kind', [
  lightSampleSchema.extend({ kind: z.literal('light') }),
  fullSampleSchema.extend({ kind: z.literal('full') }),
  z.strictObject({ kind: z.literal('unavailable') }),
])
export type SystemMetrics = z.infer<typeof systemMetricsSchema>

/** Rows of the System view's process list: the sampler's default limit and the IPC event's maximum. */
export const PROCESS_LIMIT = 5

export const processRowSchema = z.strictObject({
  pid: z.int().positive(),
  name: z.string().max(260),
  cpuPercent: percentSchema.nullable(),
  privateBytes: bytesSchema.nullable(),
  /** ISO-8601 start instant; with the pid it identifies the process across pid reuse. */
  startTime: z.string().max(40),
  killable: z.boolean(),
})
export type ProcessRow = z.infer<typeof processRowSchema>

export const processOrderSchema = z.enum(['cpu', 'ram'])
export type ProcessOrder = z.infer<typeof processOrderSchema>

export const killResultSchema = z.enum(['killed', 'gone', 'denied', 'not-killable'])
export type KillResult = z.infer<typeof killResultSchema>

export const killInputSchema = z.strictObject({
  pid: z.int().positive(),
  startTime: z.string().max(40),
})
export type KillInput = z.infer<typeof killInputSchema>

/** The System view's process order; whether the view is open follows the notch mode in main. */
export const viewInputSchema = z.strictObject({
  by: processOrderSchema,
})
export type ViewInput = z.infer<typeof viewInputSchema>
