import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createUsageLog, USAGE_LATENCY_CAP, USAGE_RETENTION_DAYS } from '../../../src/main/services/usage-log'
import { usageSummarySchema } from '../../../src/shared/usage/schema'
import { createMemoryLogger } from '../helpers/memory-logger'

let dir: string
let file: string
let clock: Date

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usage-log-'))
  file = join(dir, 'usage.json')
  // 10:00 local (Madrid, CET = UTC+1).
  clock = new Date('2026-11-10T09:00:00.000Z')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const make = () => {
  const logger = createMemoryLogger()
  return { logger, usage: createUsageLog({ file, logger, now: () => clock }) }
}

const readDisk = async () => JSON.parse(await readFile(file, 'utf8')) as { version: number; days: Record<string, Record<string, unknown>> }

describe('usage log', () => {
  it('runs in Europe/Madrid', () => {
    expect(new Date('2026-11-10T23:30:00.000Z').getDate()).toBe(11)
  })

  it('starts empty when there is no file and writes nothing until a flush with changes', async () => {
    const { usage } = make()
    await usage.load()
    await usage.flush()
    await expect(readdir(dir)).resolves.toEqual([])
    expect(usage.summary(14)).toMatchObject({ days: 0, launches: 0, claudeLatencyMedianMs: null, claudeLatencyP95Ms: null })
  })

  it('aggregates events per local day and persists them', async () => {
    const { usage } = make()
    await usage.load()
    usage.record({ type: 'launch' })
    usage.tick()
    usage.tick()
    usage.record({ type: 'reminders-fired', count: 2 })
    usage.record({ type: 'reminders-missed', count: 3 })
    usage.record({ type: 'reminder-completed' })
    usage.record({ type: 'reminder-completed' })
    usage.record({ type: 'claude-alert', latencyMs: 40 })
    await usage.flush()

    const disk = await readDisk()
    expect(disk.version).toBe(1)
    expect(disk.days['2026-11-10']).toEqual({
      runningMinutes: 2,
      launches: 1,
      remindersFired: 2,
      remindersMissed: 3,
      remindersCompleted: 2,
      claudeAlerts: 1,
      claudeLatencyMs: [40],
    })
  })

  it('counts a fresh launch as a used day even before the first full minute', async () => {
    const { usage } = make()
    await usage.load()
    usage.record({ type: 'launch' })
    expect(usage.summary(14)).toMatchObject({ days: 1, launches: 1, runningHoursAvg: 0 })
  })

  it('rolls over to the next day at local midnight, not UTC midnight', async () => {
    const { usage } = make()
    await usage.load()
    clock = new Date('2026-11-10T22:59:30.000Z') // 23:59:30 Madrid
    usage.tick()
    clock = new Date('2026-11-10T23:00:30.000Z') // 00:00:30 Madrid, next day
    usage.tick()
    usage.record({ type: 'launch' })
    await usage.flush()

    const disk = await readDisk()
    expect(disk.days['2026-11-10']).toMatchObject({ runningMinutes: 1, launches: 0 })
    expect(disk.days['2026-11-11']).toMatchObject({ runningMinutes: 1, launches: 1 })
  })

  it('keeps events recorded before load finished and merges them with the file', async () => {
    await writeFile(
      file,
      JSON.stringify({ version: 1, days: { '2026-11-10': { runningMinutes: 5, launches: 1, remindersFired: 0, remindersMissed: 0, remindersCompleted: 0, claudeAlerts: 1, claudeLatencyMs: [10] } } }),
    )
    const { usage } = make()
    usage.record({ type: 'launch' })
    usage.record({ type: 'claude-alert', latencyMs: 30 })
    await usage.load()
    await usage.flush()
    expect((await readDisk()).days['2026-11-10']).toMatchObject({ runningMinutes: 5, launches: 2, claudeAlerts: 2, claudeLatencyMs: [10, 30] })
  })

  it(`prunes days older than ${USAGE_RETENTION_DAYS} days on load`, async () => {
    const day = { runningMinutes: 1, launches: 1, remindersFired: 0, remindersMissed: 0, remindersCompleted: 0, claudeAlerts: 0, claudeLatencyMs: [] }
    // Today is 2026-11-10: the oldest kept day is 2026-08-13 (90 days including today).
    await writeFile(file, JSON.stringify({ version: 1, days: { '2026-08-12': day, '2026-08-13': day, '2026-11-09': day } }))
    const { usage } = make()
    await usage.load()
    usage.record({ type: 'launch' })
    await usage.flush()
    expect(Object.keys((await readDisk()).days).sort()).toEqual(['2026-08-13', '2026-11-09', '2026-11-10'])
  })

  it(`caps stored latencies at ${USAGE_LATENCY_CAP} per day but keeps counting alerts`, async () => {
    const { usage } = make()
    await usage.load()
    for (let i = 0; i < USAGE_LATENCY_CAP + 5; i++) usage.record({ type: 'claude-alert', latencyMs: i })
    usage.record({ type: 'claude-alert', latencyMs: -3 })
    await usage.flush()
    const today = (await readDisk()).days['2026-11-10']!
    expect(today['claudeAlerts']).toBe(USAGE_LATENCY_CAP + 6)
    expect(today['claudeLatencyMs']).toHaveLength(USAGE_LATENCY_CAP)
  })

  it('computes median and p95 latency over the range', async () => {
    const { usage } = make()
    await usage.load()
    for (let ms = 1; ms <= 20; ms++) usage.record({ type: 'claude-alert', latencyMs: ms * 10 })
    const summary = usage.summary(14)
    expect(summary.claudeLatencyMedianMs).toBe(105) // mean of 100 and 110
    expect(summary.claudeLatencyP95Ms).toBe(190) // nearest rank: ceil(0.95 * 20) = 19th
    expect(summary.claudeAlerts).toBe(20)
  })

  it('rounds non-integer latencies so the summary stays integral', async () => {
    const { usage } = make()
    await usage.load()
    usage.record({ type: 'claude-alert', latencyMs: 12.6 })
    expect(usage.summary(7)).toMatchObject({ claudeLatencyMedianMs: 13, claudeLatencyP95Ms: 13 })
  })

  it('summarizes a range with empty days and ignores days outside it', async () => {
    const day = (runningMinutes: number, launches: number) => ({
      runningMinutes,
      launches,
      remindersFired: 1,
      remindersMissed: 0,
      remindersCompleted: 1,
      claudeAlerts: 0,
      claudeLatencyMs: [],
    })
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        // A 7-day range is 2026-11-04..2026-11-10: 2026-11-03 falls outside it.
        // 2026-11-08 has a launch but no full minute: it still counts as used.
        days: {
          '2026-11-03': day(600, 9),
          '2026-11-05': day(120, 1),
          '2026-11-07': day(0, 0),
          '2026-11-08': day(0, 1),
          '2026-11-10': day(240, 2),
        },
      }),
    )
    const { usage } = make()
    await usage.load()
    const summary = usage.summary(7)
    expect(usageSummarySchema.parse(summary)).toEqual({
      days: 3,
      runningHoursAvg: 2, // (120 + 0 + 240) min / 60 / 3 used days
      launches: 4,
      remindersFired: 4,
      remindersMissed: 0,
      remindersCompleted: 4,
      claudeAlerts: 0,
      claudeLatencyMedianMs: null,
      claudeLatencyP95Ms: null,
      from: '2026-11-04',
      to: '2026-11-10',
    })
    expect(usage.summary(14)).toMatchObject({ days: 4, launches: 13, from: '2026-10-28' })
  })

  it('quarantines a corrupt file and starts empty', async () => {
    await writeFile(file, '{ not json')
    const { usage, logger } = make()
    await usage.load()
    const files = await readdir(dir)
    expect(files.some((f) => f.startsWith('usage.corrupt-') && f.endsWith('.json'))).toBe(true)
    expect(files).not.toContain('usage.json')
    expect(logger.entries.some((e) => e.level === 'warn')).toBe(true)
    usage.record({ type: 'launch' })
    await usage.flush()
    expect((await readDisk()).days['2026-11-10']).toMatchObject({ launches: 1 })
  })

  it('quarantines a file that does not match the schema', async () => {
    await writeFile(file, JSON.stringify({ version: 1, days: { '2026-11-10': { launches: -1 } } }))
    const { usage } = make()
    await usage.load()
    expect((await readdir(dir)).some((f) => f.startsWith('usage.corrupt-'))).toBe(true)
    expect(usage.summary(14).launches).toBe(0)
  })

  it('never overwrites a file from a newer version', async () => {
    const newer = JSON.stringify({ version: 2, days: {} })
    await writeFile(file, newer)
    const { usage } = make()
    await usage.load()
    usage.record({ type: 'launch' })
    await usage.flush()
    expect(await readFile(file, 'utf8')).toBe(newer)
  })

  it('serializes flushes so the last write wins and none overlap', async () => {
    const { usage } = make()
    await usage.load()
    usage.record({ type: 'launch' })
    const first = usage.flush()
    usage.record({ type: 'launch' })
    const second = usage.flush()
    usage.record({ type: 'launch' })
    const third = usage.flush()
    await Promise.all([first, second, third])
    expect((await readDisk()).days['2026-11-10']).toMatchObject({ launches: 3 })
    // No temp files left behind by overlapping writes.
    expect(await readdir(dir)).toEqual(['usage.json'])
  })

  it('does not write before load ran, so an unread file is never clobbered', async () => {
    const original = JSON.stringify({ version: 1, days: {} })
    await writeFile(file, original)
    const { usage } = make()
    usage.record({ type: 'launch' })
    await usage.flush()
    expect(await readFile(file, 'utf8')).toBe(original)
  })

  it('stores nothing but counts', async () => {
    const { usage } = make()
    await usage.load()
    usage.record({ type: 'launch' })
    usage.record({ type: 'claude-alert', latencyMs: 5 })
    await usage.flush()
    const text = await readFile(file, 'utf8')
    expect(text).not.toMatch(/text|session|path|command/i)
  })
})
