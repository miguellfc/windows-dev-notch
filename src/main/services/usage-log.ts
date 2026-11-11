import { rename } from 'node:fs/promises'
import { join, parse } from 'node:path'
import { z } from 'zod'
import { dayKeySchema, type UsageSummary } from '../../shared/usage/schema'
import { readTextFile, writeFileAtomic } from './fs-atomic'
import type { Logger } from './logger'

/** Days kept on disk, today included; older days are pruned on load. */
export const USAGE_RETENTION_DAYS = 90
/** Latency samples stored per day; later alerts are still counted. */
export const USAGE_LATENCY_CAP = 200

const CURRENT_VERSION = 1

export type UsageEvent =
  | { type: 'launch' }
  | { type: 'reminders-fired'; count: number }
  | { type: 'reminders-missed'; count: number }
  | { type: 'reminder-completed' }
  /**
   * A new Claude permission request turned the capsule into alert. `latencyMs` goes from the bridge
   * receiving the HTTP request (before reading its body) to the notch controller applying
   * `attention`, both measured in main; the renderer's paint is not included.
   */
  | { type: 'claude-alert'; latencyMs: number }

export interface UsageLogOptions {
  file: string
  logger: Logger
  now: () => Date
}

export interface UsageLog {
  /** Reads the file (never rejects); events recorded before it finishes are kept and merged. */
  load(): Promise<void>
  record(event: UsageEvent): void
  /** Called every 60 s: one running minute for today, then a flush. */
  tick(): void
  /** Writes pending changes; serialized, never rejects, no-op before `load()` or without changes. */
  flush(): Promise<void>
  summary(days: number): UsageSummary
}

const count = z.int().nonnegative()
const usageDaySchema = z.strictObject({
  runningMinutes: count,
  launches: count,
  remindersFired: count,
  remindersMissed: count,
  remindersCompleted: count,
  claudeAlerts: count,
  claudeLatencyMs: z.array(count).max(USAGE_LATENCY_CAP),
})
type UsageDay = z.infer<typeof usageDaySchema>

const usageFileSchema = z.strictObject({
  version: z.literal(CURRENT_VERSION),
  days: z.record(dayKeySchema, usageDaySchema),
})

const emptyDay = (): UsageDay => ({
  runningMinutes: 0,
  launches: 0,
  remindersFired: 0,
  remindersMissed: 0,
  remindersCompleted: 0,
  claudeAlerts: 0,
  claudeLatencyMs: [],
})

const pad = (n: number): string => String(n).padStart(2, '0')
/** Local calendar day of `date`. */
const dayKey = (date: Date): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
/** Local day `offset` days from `date` (calendar arithmetic, safe across DST changes). */
const shiftDay = (date: Date, offset: number): Date => new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset)

const isNewerVersion = (raw: unknown): boolean =>
  typeof raw === 'object' &&
  raw !== null &&
  typeof (raw as { version?: unknown }).version === 'number' &&
  (raw as { version: number }).version > CURRENT_VERSION

const addLatencies = (into: number[], more: readonly number[]): void => {
  for (const ms of more) {
    if (into.length >= USAGE_LATENCY_CAP) return
    into.push(ms)
  }
}

const mergeDay = (into: UsageDay, from: UsageDay): void => {
  into.runningMinutes += from.runningMinutes
  into.launches += from.launches
  into.remindersFired += from.remindersFired
  into.remindersMissed += from.remindersMissed
  into.remindersCompleted += from.remindersCompleted
  into.claudeAlerts += from.claudeAlerts
  addLatencies(into.claudeLatencyMs, from.claudeLatencyMs)
}

const median = (sorted: readonly number[]): number => {
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** Nearest-rank percentile. */
const percentile = (sorted: readonly number[], p: number): number => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!

const safeCount = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0)

/**
 * Local, counts-only usage log (`usage.json`) used to check the PRD success metrics. Daily
 * aggregates by local calendar day; no reminder text, session names, paths or commands.
 */
export const createUsageLog = ({ file, logger, now }: UsageLogOptions): UsageLog => {
  const log = logger.child('usage')
  let days: Record<string, UsageDay> = {}
  let loaded = false
  let readOnly = false
  let dirty = false
  let queue: Promise<void> = Promise.resolve()

  const today = (): UsageDay => {
    const key = dayKey(now())
    days[key] ??= emptyDay()
    return days[key]
  }

  const prune = (): void => {
    const oldest = dayKey(shiftDay(now(), -(USAGE_RETENTION_DAYS - 1)))
    for (const key of Object.keys(days)) if (key < oldest) delete days[key]
  }

  const quarantine = async (reason: string): Promise<void> => {
    const { dir, name } = parse(file)
    const stamp = now().toISOString().replace(/[:.]/g, '-')
    const target = join(dir, `${name}.corrupt-${stamp}.json`)
    await rename(file, target)
    log.warn(`${reason}; moved it aside and started a new log`, { quarantine: target })
  }

  /** Returns the days read from disk (empty when there is no file or it was moved aside). */
  const readFromDisk = async (): Promise<Record<string, UsageDay>> => {
    const text = await readTextFile(file)
    if (text === null) return {}
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      await quarantine('Usage file is not valid JSON')
      return {}
    }
    if (isNewerVersion(raw)) {
      log.warn('Usage file comes from a newer version; not recording to disk this session')
      readOnly = true
      return {}
    }
    const parsed = usageFileSchema.safeParse(raw)
    if (!parsed.success) {
      await quarantine('Usage file does not match the schema')
      return {}
    }
    return parsed.data.days
  }

  const write = async (): Promise<void> => {
    if (!loaded || readOnly || !dirty) return
    dirty = false
    try {
      const data = usageFileSchema.parse({ version: CURRENT_VERSION, days })
      await writeFileAtomic(file, `${JSON.stringify(data)}\n`)
    } catch (error) {
      dirty = true
      log.error('Could not save the usage log', { error })
    }
  }

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    queue = queue.then(task, task)
    return queue
  }

  return {
    load: () =>
      enqueue(async () => {
        let fromDisk: Record<string, UsageDay> = {}
        try {
          fromDisk = await readFromDisk()
        } catch (error) {
          log.error('Could not load the usage log; not recording to disk this session', { error })
          readOnly = true
        }
        // Events recorded while the file was being read are added on top of it.
        for (const [key, day] of Object.entries(days)) {
          fromDisk[key] ??= emptyDay()
          mergeDay(fromDisk[key], day)
        }
        days = fromDisk
        prune()
        loaded = true
      }),

    record(event) {
      const day = today()
      switch (event.type) {
        case 'launch':
          day.launches += 1
          break
        case 'reminders-fired':
          day.remindersFired += safeCount(event.count)
          break
        case 'reminders-missed':
          day.remindersMissed += safeCount(event.count)
          break
        case 'reminder-completed':
          day.remindersCompleted += 1
          break
        case 'claude-alert':
          day.claudeAlerts += 1
          addLatencies(day.claudeLatencyMs, [safeCount(event.latencyMs)])
          break
      }
      dirty = true
    },

    tick() {
      today().runningMinutes += 1
      dirty = true
      void enqueue(write)
    },

    flush: () => enqueue(write),

    summary(rangeDays) {
      const end = now()
      const total = emptyDay()
      let used = 0
      const latencies: number[] = []
      for (let offset = rangeDays - 1; offset >= 0; offset--) {
        const day = days[dayKey(shiftDay(end, -offset))]
        if (!day) continue
        // A launch counts too, so a fresh start never shows 0 days next to 1 launch.
        if (day.runningMinutes > 0 || day.launches > 0) used += 1
        mergeDay(total, { ...day, claudeLatencyMs: [] })
        latencies.push(...day.claudeLatencyMs)
      }
      latencies.sort((a, b) => a - b)
      return {
        days: used,
        runningHoursAvg: used === 0 ? 0 : total.runningMinutes / 60 / used,
        launches: total.launches,
        remindersFired: total.remindersFired,
        remindersMissed: total.remindersMissed,
        remindersCompleted: total.remindersCompleted,
        claudeAlerts: total.claudeAlerts,
        claudeLatencyMedianMs: latencies.length === 0 ? null : Math.round(median(latencies)),
        claudeLatencyP95Ms: latencies.length === 0 ? null : percentile(latencies, 0.95),
        from: dayKey(shiftDay(end, -(rangeDays - 1))),
        to: dayKey(end),
      }
    },
  }
}
