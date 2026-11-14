import { describe, expect, it } from 'vitest'
import { CAPSULE_MISSES, EMPTY_CAPSULE, nextCapsule, type CapsuleLatch } from '../../../src/renderer/notch/system/capsule-latch'
import { NO_ALERTS, type SystemAlerts, type SystemMetrics } from '../../../src/shared/system/schema'

const GB = 1024 ** 3
const light = (
  battery: { percent: number; charging: boolean; pluggedIn: boolean } | null,
  cpuPercent: number | null = 30,
  alerts: SystemAlerts = NO_ALERTS,
): SystemMetrics => ({
  kind: 'light',
  cpuPercent,
  ram: { usedBytes: 8 * GB, totalBytes: 16 * GB },
  battery: battery && { ...battery, secondsLeft: null },
  alerts,
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
      disk: null,
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
    }
    expect(feed([full]).view).toEqual({ cpuPercent: 30, ramPercent: 50, battery: null, alerts: QUIET, disk: null })
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
      disk: null,
    })
  })

  it('stays empty when the monitor is unavailable from the start', () => {
    expect(feed([UNAVAILABLE]).view).toBeNull()
  })

  it('treats an empty RAM total as unknown', () => {
    const sample: SystemMetrics = { kind: 'light', cpuPercent: null, ram: { usedBytes: 0, totalBytes: 0 }, battery: null, alerts: NO_ALERTS }
    expect(feed([sample]).view).toEqual({ cpuPercent: null, ramPercent: null, battery: null, alerts: QUIET, disk: null })
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

  it('shows the disk block with the first low-disk sample and follows its value', () => {
    const shown = feed([light(null, 30, lowDisk('C', 6))])
    expect(shown.view?.disk).toEqual({ letter: 'C', freePercent: 6 })
    expect(feed([light(null, 30, lowDisk('D', 4))], shown).view?.disk).toEqual({ letter: 'D', freePercent: 4 })
  })

  it('keeps the disk block until the disk alert is gone in 3 samples in a row', () => {
    const shown = feed([light(null, 30, lowDisk())])
    expect(feed([light(null), light(null)], shown).view?.disk).toEqual({ letter: 'C', freePercent: 6 })
    expect(feed([light(null), light(null), light(null)], shown).view?.disk).toBeNull()
  })

  it('resets the disk miss count when the disk alert comes back', () => {
    const latch = feed([light(null, 30, lowDisk()), light(null), light(null), light(null, 30, lowDisk('C', 5)), light(null), light(null)])
    expect(latch.view?.disk).toEqual({ letter: 'C', freePercent: 5 })
  })

  it('never shows a disk block without a disk alert', () => {
    expect(feed([light(null), light(null)]).view?.disk).toBeNull()
  })

  it('drops the disk block with the rest of the metrics when the monitor is lost', () => {
    const shown = feed([light(null, 30, lowDisk())])
    expect(feed([UNAVAILABLE, UNAVAILABLE], shown).view?.disk).toEqual({ letter: 'C', freePercent: 6 })
    expect(feed([UNAVAILABLE, UNAVAILABLE, UNAVAILABLE], shown).view).toBeNull()
  })
})
