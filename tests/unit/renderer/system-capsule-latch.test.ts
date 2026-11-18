import { describe, expect, it } from 'vitest'
import { CAPSULE_MISSES, EMPTY_CAPSULE, nextCapsule, type CapsuleLatch } from '../../../src/renderer/notch/system/capsule-latch'
import { NO_ALERTS, type SystemAlerts, type SystemMetrics } from '../../../src/shared/system/schema'

const GB = 1024 ** 3
const light = (
  battery: { percent: number; charging: boolean; pluggedIn: boolean } | null,
  cpuPercent: number | null = 30,
  alerts: SystemAlerts = NO_ALERTS,
  storage: { letter: string; usedPercent: number } | null = null,
): SystemMetrics => ({
  kind: 'light',
  cpuPercent,
  ram: { usedBytes: 8 * GB, totalBytes: 16 * GB },
  battery: battery && { ...battery, secondsLeft: null },
  alerts,
  storage,
})
const QUIET = { cpu: false, ram: false, battery: false }
const ON_BATTERY = { percent: 12, charging: false, pluggedIn: false }
const lowDisk = (letter = 'C', freePercent = 6): SystemAlerts => ({ ...NO_ALERTS, disk: { letter, freePercent } })
const UNAVAILABLE: SystemMetrics = { kind: 'unavailable' }
const feed = (samples: SystemMetrics[], from: CapsuleLatch = EMPTY_CAPSULE): CapsuleLatch => samples.reduce(nextCapsule, from)

describe('nextCapsule', () => {
  it('starts with nothing to show, and shows the first sample at once', () => {
    expect(EMPTY_CAPSULE.view).toBeNull()
    expect(feed([light({ percent: 82, charging: true, pluggedIn: true })]).view).toEqual({
      cpuPercent: 30,
      ramPercent: 50,
      battery: { percent: 82, charging: true, pluggedIn: true },
      alerts: QUIET,
      storage: { letter: 'C', usedPercent: null, alert: false },
    })
  })

  it('maps a full sample like a light one', () => {
    const full: SystemMetrics = {
      kind: 'full',
      cpuPercent: 30,
      ram: { usedBytes: 8 * GB, totalBytes: 16 * GB },
      battery: null,
      disks: [],
      network: null,
      alerts: NO_ALERTS,
      storage: null,
    }
    expect(feed([full]).view).toEqual({ cpuPercent: 30, ramPercent: 50, battery: null, alerts: QUIET, storage: { letter: 'C', usedPercent: null, alert: false } })
  })

  it('never shows a battery slot on a machine that never reported one', () => {
    expect(feed([light(null), light(null)]).view?.battery).toBeNull()
  })

  it('keeps the last battery value until it is missing in 3 samples in a row', () => {
    const seen = feed([light({ percent: 82, charging: false, pluggedIn: false })])
    expect(CAPSULE_MISSES).toBe(3)
    expect(feed([light(null), light(null)], seen).view?.battery).toEqual({ percent: 82, charging: false, pluggedIn: false })
    expect(feed([light(null), light(null), light(null)], seen).view?.battery).toBeNull()
  })

  it('resets the battery miss count when the battery comes back', () => {
    const latch = feed([light({ percent: 82, charging: false, pluggedIn: false }), light(null), light(null), light({ percent: 81, charging: false, pluggedIn: false }), light(null), light(null)])
    expect(latch.view?.battery).toEqual({ percent: 81, charging: false, pluggedIn: false })
  })

  it('keeps the metrics through up to 2 unavailable samples, then drops them', () => {
    const seen = feed([light({ percent: 82, charging: false, pluggedIn: false }, 40)])
    expect(feed([UNAVAILABLE, UNAVAILABLE], seen).view).toEqual(seen.view)
    expect(feed([UNAVAILABLE, UNAVAILABLE, UNAVAILABLE], seen).view).toBeNull()
    expect(feed([UNAVAILABLE, UNAVAILABLE, light(null, 10)], seen).view).toEqual({
      cpuPercent: 10,
      ramPercent: 50,
      battery: { percent: 82, charging: false, pluggedIn: false },
      alerts: QUIET,
      storage: { letter: 'C', usedPercent: null, alert: false },
    })
  })

  it('stays empty when the monitor is unavailable from the start', () => {
    expect(feed([UNAVAILABLE]).view).toBeNull()
  })

  it('treats an empty RAM total as unknown', () => {
    const sample: SystemMetrics = { kind: 'light', cpuPercent: null, ram: { usedBytes: 0, totalBytes: 0 }, battery: null, alerts: NO_ALERTS, storage: null }
    expect(feed([sample]).view).toEqual({ cpuPercent: null, ramPercent: null, battery: null, alerts: QUIET, storage: { letter: 'C', usedPercent: null, alert: false } })
  })

  it('carries the CPU, RAM and battery alerts of each sample, unlatched', () => {
    const alerting = feed([light(ON_BATTERY, 95, { cpu: true, ram: true, battery: true, disk: null })])
    expect(alerting.view?.alerts).toEqual({ cpu: true, ram: true, battery: true })
    expect(feed([light(ON_BATTERY)], alerting).view?.alerts).toEqual(QUIET)
  })

  it('keeps the battery alert with the held battery value while the battery is missing', () => {
    const alerting = feed([light(ON_BATTERY, 30, { ...NO_ALERTS, battery: true })])
    const held = feed([light(null), light(null)], alerting)
    expect(held.view?.battery).toEqual(ON_BATTERY)
    expect(held.view?.alerts.battery).toBe(true)
    expect(feed([light(null)], held).view?.alerts.battery).toBe(false)
  })

  it('shows the storage of the sample, without alert', () => {
    expect(feed([light(null, 30, NO_ALERTS, { letter: 'C', usedPercent: 62 })]).view?.storage).toEqual({ letter: 'C', usedPercent: 62, alert: false })
  })

  it('flags the storage while the disk alert points at it', () => {
    const view = feed([light(null, 30, lowDisk('C', 5), { letter: 'C', usedPercent: 95 })]).view
    expect(view?.storage).toEqual({ letter: 'C', usedPercent: 95, alert: true })
  })

  it('keeps the storage alert until the disk alert is gone in 3 samples in a row', () => {
    const shown = feed([light(null, 30, lowDisk('C', 5), { letter: 'C', usedPercent: 95 })])
    const quiet = light(null, 30, NO_ALERTS, { letter: 'C', usedPercent: 90 })
    expect(feed([quiet, quiet], shown).view?.storage).toEqual({ letter: 'C', usedPercent: 90, alert: true })
    expect(feed([quiet, quiet, quiet], shown).view?.storage).toEqual({ letter: 'C', usedPercent: 90, alert: false })
  })

  it('resets the storage miss count when the disk alert comes back', () => {
    const q = light(null, 30, NO_ALERTS, { letter: 'C', usedPercent: 90 })
    const a = light(null, 30, lowDisk('C', 5), { letter: 'C', usedPercent: 95 })
    expect(feed([a, q, q, a, q, q]).view?.storage?.alert).toBe(true)
  })

  it('without storage in the sample, usedPercent is null and the letter follows the alert', () => {
    expect(feed([light(null, 30, lowDisk('D', 4))]).view?.storage).toEqual({ letter: 'D', usedPercent: null, alert: true })
    expect(feed([light(null)]).view?.storage).toEqual({ letter: 'C', usedPercent: null, alert: false })
  })

  it('drops the storage with the rest of the metrics when the monitor is lost', () => {
    const shown = feed([light(null, 30, NO_ALERTS, { letter: 'C', usedPercent: 62 })])
    expect(feed([UNAVAILABLE, UNAVAILABLE], shown).view?.storage).toEqual({ letter: 'C', usedPercent: 62, alert: false })
    expect(feed([UNAVAILABLE, UNAVAILABLE, UNAVAILABLE], shown).view).toBeNull()
  })
})
