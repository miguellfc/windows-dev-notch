import { describe, expect, it } from 'vitest'
import {
  fullSampleSchema,
  killInputSchema,
  killResultSchema,
  lightSampleSchema,
  processOrderSchema,
  processRowSchema,
  systemMetricsSchema,
  viewInputSchema,
} from '../../../src/shared/system/schema'

const light = {
  cpuPercent: 12.5,
  ram: { usedBytes: 8 * 2 ** 30, totalBytes: 16 * 2 ** 30 },
  battery: { percent: 80, charging: true, pluggedIn: true, secondsLeft: null },
}
const full = {
  ...light,
  disks: [{ letter: 'C', usedPercent: 55, freeBytes: 3 * 2 ** 31, activityPercent: null }],
  network: { upBytesPerSec: 10, downBytesPerSec: 2000 },
}
const row = {
  pid: 123,
  name: 'node.exe',
  cpuPercent: 3,
  privateBytes: 1024,
  startTime: '2026-11-10T10:00:00.000Z',
  killable: true,
}

describe('lightSampleSchema', () => {
  it('accepts a valid sample and nulls', () => {
    expect(lightSampleSchema.safeParse(light).success).toBe(true)
    expect(lightSampleSchema.safeParse({ cpuPercent: null, ram: null, battery: null }).success).toBe(true)
  })
  it('bounds percents to 0-100', () => {
    expect(lightSampleSchema.safeParse({ ...light, cpuPercent: -1 }).success).toBe(false)
    expect(lightSampleSchema.safeParse({ ...light, cpuPercent: 100.1 }).success).toBe(false)
    expect(lightSampleSchema.safeParse({ ...light, cpuPercent: 0 }).success).toBe(true)
    expect(lightSampleSchema.safeParse({ ...light, battery: { ...light.battery, percent: 101 } }).success).toBe(false)
  })
  it('requires pluggedIn on the battery', () => {
    const withoutPluggedIn: Record<string, unknown> = { ...light.battery }
    delete withoutPluggedIn.pluggedIn
    expect(lightSampleSchema.safeParse({ ...light, battery: withoutPluggedIn }).success).toBe(false)
    expect(lightSampleSchema.safeParse({ ...light, battery: { ...light.battery, charging: false, pluggedIn: true } }).success).toBe(true)
  })
  it('rejects a NaN percent', () => {
    expect(lightSampleSchema.safeParse({ ...light, cpuPercent: Number.NaN }).success).toBe(false)
  })
  it('requires non-negative bytes', () => {
    expect(lightSampleSchema.safeParse({ ...light, ram: { usedBytes: -1, totalBytes: 1 } }).success).toBe(false)
  })
  it('secondsLeft is a non-negative int or null', () => {
    const b = (secondsLeft: number | null) => ({ ...light, battery: { ...light.battery, secondsLeft } })
    expect(lightSampleSchema.safeParse(b(60)).success).toBe(true)
    expect(lightSampleSchema.safeParse(b(-1)).success).toBe(false)
    expect(lightSampleSchema.safeParse(b(1.5)).success).toBe(false)
  })
  it('is strict', () => {
    expect(lightSampleSchema.safeParse({ ...light, extra: 1 }).success).toBe(false)
    expect(lightSampleSchema.safeParse({ ...light, ram: { ...light.ram, extra: 1 } }).success).toBe(false)
  })
})

describe('fullSampleSchema', () => {
  it('accepts a valid sample, bytes above 2^31', () => {
    expect(fullSampleSchema.safeParse(full).success).toBe(true)
    expect(fullSampleSchema.safeParse({ ...full, network: null, disks: [] }).success).toBe(true)
  })
  it('letter must be one uppercase A-Z', () => {
    const d = (letter: string) => ({ ...full, disks: [{ ...full.disks[0], letter }] })
    expect(fullSampleSchema.safeParse(d('D')).success).toBe(true)
    for (const bad of ['', 'c', 'CD', '1', 'É']) expect(fullSampleSchema.safeParse(d(bad)).success).toBe(false)
  })
  it('bounds disk percents and bytes', () => {
    const d = (o: object) => ({ ...full, disks: [{ ...full.disks[0], ...o }] })
    expect(fullSampleSchema.safeParse(d({ usedPercent: 101 })).success).toBe(false)
    expect(fullSampleSchema.safeParse(d({ activityPercent: -1 })).success).toBe(false)
    expect(fullSampleSchema.safeParse(d({ freeBytes: -1 })).success).toBe(false)
    expect(fullSampleSchema.safeParse({ ...full, network: { upBytesPerSec: -1, downBytesPerSec: 0 } }).success).toBe(
      false,
    )
  })
  it('is strict', () => {
    expect(fullSampleSchema.safeParse({ ...full, extra: 1 }).success).toBe(false)
    expect(fullSampleSchema.safeParse({ ...full, disks: [{ ...full.disks[0], extra: 1 }] }).success).toBe(false)
  })
})

describe('systemMetricsSchema', () => {
  it('discriminates by kind', () => {
    expect(systemMetricsSchema.safeParse({ kind: 'light', ...light }).success).toBe(true)
    expect(systemMetricsSchema.safeParse({ kind: 'full', ...full }).success).toBe(true)
    expect(systemMetricsSchema.safeParse({ kind: 'unavailable' }).success).toBe(true)
  })
  it('rejects unknown kind, missing kind and extra keys', () => {
    expect(systemMetricsSchema.safeParse({ kind: 'heavy', ...light }).success).toBe(false)
    expect(systemMetricsSchema.safeParse(light).success).toBe(false)
    expect(systemMetricsSchema.safeParse({ kind: 'unavailable', cpuPercent: 1 }).success).toBe(false)
    expect(systemMetricsSchema.safeParse({ kind: 'light', ...full }).success).toBe(false)
  })
})

describe('processRowSchema', () => {
  it('accepts a valid row', () => {
    expect(processRowSchema.safeParse(row).success).toBe(true)
    expect(processRowSchema.safeParse({ ...row, cpuPercent: null, privateBytes: null }).success).toBe(true)
  })
  it('validates fields', () => {
    expect(processRowSchema.safeParse({ ...row, pid: 0 }).success).toBe(false)
    expect(processRowSchema.safeParse({ ...row, pid: 1.5 }).success).toBe(false)
    expect(processRowSchema.safeParse({ ...row, name: 'a'.repeat(261) }).success).toBe(false)
    expect(processRowSchema.safeParse({ ...row, name: 'a'.repeat(260) }).success).toBe(true)
    expect(processRowSchema.safeParse({ ...row, startTime: 'x'.repeat(41) }).success).toBe(false)
    expect(processRowSchema.safeParse({ ...row, privateBytes: -1 }).success).toBe(false)
    expect(processRowSchema.safeParse({ ...row, cpuPercent: 101 }).success).toBe(false)
  })
  it('is strict', () => {
    expect(processRowSchema.safeParse({ ...row, extra: 1 }).success).toBe(false)
  })
})

describe('enums and inputs', () => {
  it('processOrderSchema and killResultSchema', () => {
    expect(processOrderSchema.safeParse('cpu').success).toBe(true)
    expect(processOrderSchema.safeParse('ram').success).toBe(true)
    expect(processOrderSchema.safeParse('disk').success).toBe(false)
    for (const r of ['killed', 'gone', 'denied', 'not-killable']) expect(killResultSchema.safeParse(r).success).toBe(true)
    expect(killResultSchema.safeParse('ok').success).toBe(false)
  })
  it('killInputSchema', () => {
    expect(killInputSchema.safeParse({ pid: 4, startTime: row.startTime }).success).toBe(true)
    expect(killInputSchema.safeParse({ pid: 0, startTime: 'x' }).success).toBe(false)
    expect(killInputSchema.safeParse({ pid: -3, startTime: 'x' }).success).toBe(false)
    expect(killInputSchema.safeParse({ pid: 4, startTime: 'x'.repeat(41) }).success).toBe(false)
    expect(killInputSchema.safeParse({ pid: 4, startTime: 'x', extra: 1 }).success).toBe(false)
  })
  it('viewInputSchema', () => {
    expect(viewInputSchema.safeParse({ by: 'ram' }).success).toBe(true)
    expect(viewInputSchema.safeParse({ by: 'cpu' }).success).toBe(true)
    expect(viewInputSchema.safeParse({ open: true }).success).toBe(false)
    expect(viewInputSchema.safeParse({ by: 'x' }).success).toBe(false)
    expect(viewInputSchema.safeParse({ by: 'cpu', extra: 1 }).success).toBe(false)
  })
})
