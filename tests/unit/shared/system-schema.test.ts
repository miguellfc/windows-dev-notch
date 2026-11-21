import { describe, expect, it } from 'vitest'
import { lightSampleSchema, NO_ALERTS, systemAlertsSchema, systemMetricsSchema } from '../../../src/shared/system/schema'

const light = {
  cpuPercent: 12.5,
  ram: { usedBytes: 8 * 2 ** 30, totalBytes: 16 * 2 ** 30 },
  battery: { percent: 80, charging: true, pluggedIn: true, secondsLeft: null },
  alerts: NO_ALERTS,
  storage: { usedPercent: 62 },
  online: true,
}
describe('systemAlertsSchema', () => {
  it('NO_ALERTS is valid and everything is off', () => {
    expect(systemAlertsSchema.parse(NO_ALERTS)).toEqual({ cpu: false, ram: false, battery: false, disk: null })
  })
  it('accepts active alerts with a worst disk', () => {
    const alerts = { cpu: true, ram: true, battery: true, disk: { letter: 'C', freePercent: 6 } }
    expect(systemAlertsSchema.safeParse(alerts).success).toBe(true)
  })
  it('disk letter is one uppercase A-Z and freePercent is 0-100', () => {
    const d = (o: object) => ({ ...NO_ALERTS, disk: { letter: 'C', freePercent: 6, ...o } })
    for (const bad of ['', 'c', 'CD', '1', 'É']) expect(systemAlertsSchema.safeParse(d({ letter: bad })).success).toBe(false)
    expect(systemAlertsSchema.safeParse(d({ letter: 'Z', freePercent: 0 })).success).toBe(true)
    expect(systemAlertsSchema.safeParse(d({ freePercent: 100 })).success).toBe(true)
    expect(systemAlertsSchema.safeParse(d({ freePercent: -1 })).success).toBe(false)
    expect(systemAlertsSchema.safeParse(d({ freePercent: 100.1 })).success).toBe(false)
    expect(systemAlertsSchema.safeParse(d({ freePercent: Number.NaN })).success).toBe(false)
  })
  it('is strict and requires every field', () => {
    expect(systemAlertsSchema.safeParse({ ...NO_ALERTS, extra: 1 }).success).toBe(false)
    expect(systemAlertsSchema.safeParse({ ...NO_ALERTS, disk: { letter: 'C', freePercent: 5, extra: 1 } }).success).toBe(false)
    const noDisk: Record<string, unknown> = { ...NO_ALERTS }
    delete noDisk.disk
    expect(systemAlertsSchema.safeParse(noDisk).success).toBe(false)
    expect(systemAlertsSchema.safeParse({ ...NO_ALERTS, cpu: 'yes' }).success).toBe(false)
  })
})

describe('lightSampleSchema', () => {
  it('requires online: a boolean, or null when Windows does not know', () => {
    expect(lightSampleSchema.safeParse({ ...light, online: false }).success).toBe(true)
    expect(lightSampleSchema.safeParse({ ...light, online: null }).success).toBe(true)
    for (const bad of ['offline', 0, 1, undefined]) expect(lightSampleSchema.safeParse({ ...light, online: bad }).success).toBe(false)
    const withoutOnline: Record<string, unknown> = { ...light }
    delete withoutOnline.online
    expect(lightSampleSchema.safeParse(withoutOnline).success).toBe(false)
  })
  it('requires alerts', () => {
    const withoutAlerts: Record<string, unknown> = { ...light }
    delete withoutAlerts.alerts
    expect(lightSampleSchema.safeParse(withoutAlerts).success).toBe(false)
    expect(lightSampleSchema.safeParse({ ...light, alerts: { ...NO_ALERTS, disk: { letter: 'c', freePercent: 5 } } }).success).toBe(false)
  })
  it('accepts a valid sample and nulls', () => {
    expect(lightSampleSchema.safeParse(light).success).toBe(true)
    expect(
      lightSampleSchema.safeParse({ cpuPercent: null, ram: null, battery: null, alerts: NO_ALERTS, storage: null, online: null }).success,
    ).toBe(true)
  })
  it('storage is the whole computer used 0-100 (no drive letter) or null, and required', () => {
    expect(lightSampleSchema.safeParse({ ...light, storage: null }).success).toBe(true)
    expect(lightSampleSchema.safeParse({ ...light, storage: { usedPercent: 0 } }).success).toBe(true)
    expect(lightSampleSchema.safeParse({ ...light, storage: { usedPercent: 101 } }).success).toBe(false)
    expect(lightSampleSchema.safeParse({ ...light, storage: { usedPercent: -1 } }).success).toBe(false)
    expect(lightSampleSchema.safeParse({ ...light, storage: { letter: 'C', usedPercent: 62 } }).success).toBe(false)
    expect(lightSampleSchema.safeParse({ ...light, storage: {} }).success).toBe(false)
    const withoutStorage: Record<string, unknown> = { ...light }
    delete withoutStorage.storage
    expect(lightSampleSchema.safeParse(withoutStorage).success).toBe(false)
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

describe('systemMetricsSchema', () => {
  it('discriminates by kind', () => {
    expect(systemMetricsSchema.safeParse({ kind: 'light', ...light }).success).toBe(true)
    // The full sample (disks, network) was only for the System view, which is gone.
    expect(systemMetricsSchema.safeParse({ kind: 'full', ...light, disks: [], network: null }).success).toBe(false)
    expect(systemMetricsSchema.safeParse({ kind: 'unavailable' }).success).toBe(true)
  })
  it('rejects unknown kind, missing kind and extra keys', () => {
    expect(systemMetricsSchema.safeParse({ kind: 'heavy', ...light }).success).toBe(false)
    expect(systemMetricsSchema.safeParse(light).success).toBe(false)
    expect(systemMetricsSchema.safeParse({ kind: 'unavailable', cpuPercent: 1 }).success).toBe(false)
    expect(systemMetricsSchema.safeParse({ kind: 'light', ...light, disks: [] }).success).toBe(false)
  })
})
