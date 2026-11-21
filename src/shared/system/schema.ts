import { z } from 'zod'

const percentSchema = z.number().min(0).max(100)
const bytesSchema = z.number().nonnegative()

/** Which system alerts are active; `disk` is the worst fixed drive below its threshold, if any. */
export const systemAlertsSchema = z.strictObject({
  cpu: z.boolean(),
  ram: z.boolean(),
  battery: z.boolean(),
  disk: z.strictObject({ letter: z.string().regex(/^[A-Z]$/), freePercent: percentSchema }).nullable(),
})
export type SystemAlerts = z.infer<typeof systemAlertsSchema>

/** Every alert off; frozen, so spread it (`{ ...NO_ALERTS }`) to get an object you may change. */
export const NO_ALERTS: Readonly<SystemAlerts> = Object.freeze({ cpu: false, ram: false, battery: false, disk: null })

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
  alerts: systemAlertsSchema,
  /** The whole computer's fill: used over total bytes of every fixed drive read, as %; null without a reading. */
  storage: z.strictObject({ usedPercent: percentSchema }).nullable(),
  /**
   * Whether the machine reaches the internet, from Windows' connectivity hint: false with no network,
   * a network without internet or a captive portal; null when Windows does not know (the renderer then
   * falls back to `navigator.onLine`, which only knows whether a network adapter is connected).
   */
  online: z.boolean().nullable(),
})
export type LightSample = z.infer<typeof lightSampleSchema>

export const systemMetricsSchema = z.discriminatedUnion('kind', [
  lightSampleSchema.extend({ kind: z.literal('light') }),
  z.strictObject({ kind: z.literal('unavailable') }),
])
export type SystemMetrics = z.infer<typeof systemMetricsSchema>
