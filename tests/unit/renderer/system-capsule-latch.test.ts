import { describe, expect, it } from 'vitest'
import { CAPSULE_MISSES, EMPTY_CAPSULE, nextCapsule, type CapsuleLatch } from '../../../src/renderer/notch/system/capsule-latch'
import { NO_ALERTS, type SystemAlerts, type SystemMetrics } from '../../../src/shared/system/schema'

const GB = 1024 ** 3
const light = (
  battery: { percent: number; charging: boolean; pluggedIn: boolean } | null,
  cpuPercent: number | null = 30,
  alerts: SystemAlerts = NO_ALERTS,
  usedPercent: number | null = null,
  online: boolean | null = true,
): SystemMetrics => ({
  kind: 'light',
  cpuPercent,
  ram: { usedBytes: 8 * GB, totalBytes: 16 * GB },
  battery: battery && { ...battery, secondsLeft: null },
  alerts,
  storage: usedPercent === null ? null : { usedPercent },
  online,
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
      storage: { usedPercent: null, lowDrive: null },
      online: true,
    })
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
      storage: { usedPercent: null, lowDrive: null },
      online: true,
    })
  })

  it('stays empty when the monitor is unavailable from the start', () => {
    expect(feed([UNAVAILABLE]).view).toBeNull()
  })

  it('treats an empty RAM total as unknown', () => {
    const sample: SystemMetrics = { kind: 'light', cpuPercent: null, ram: { usedBytes: 0, totalBytes: 0 }, battery: null, alerts: NO_ALERTS, storage: null, online: null }
    expect(feed([sample]).view).toEqual({ cpuPercent: null, ramPercent: null, battery: null, alerts: QUIET, storage: { usedPercent: null, lowDrive: null }, online: null })
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
    expect(feed([light(null, 30, NO_ALERTS, 62)]).view?.storage).toEqual({ usedPercent: 62, lowDrive: null })
  })

  it('flags the storage with the low drive while there is a disk alert, whatever the drive', () => {
    expect(feed([light(null, 30, lowDisk('C', 5), 95)]).view?.storage).toEqual({ usedPercent: 95, lowDrive: 'C' })
    expect(feed([light(null, 30, lowDisk('D', 4), 62)]).view?.storage).toEqual({ usedPercent: 62, lowDrive: 'D' })
  })

  it('keeps the storage alert and its drive until the disk alert is gone in 3 samples in a row', () => {
    const shown = feed([light(null, 30, lowDisk('D', 5), 95)])
    const quiet = light(null, 30, NO_ALERTS, 90)
    expect(feed([quiet, quiet], shown).view?.storage).toEqual({ usedPercent: 90, lowDrive: 'D' })
    expect(feed([quiet, quiet, quiet], shown).view?.storage).toEqual({ usedPercent: 90, lowDrive: null })
  })

  it('resets the storage miss count when the disk alert comes back', () => {
    const q = light(null, 30, NO_ALERTS, 90)
    const a = light(null, 30, lowDisk('C', 5), 95)
    expect(feed([a, q, q, a, q, q]).view?.storage?.lowDrive).toBe('C')
  })

  it('follows the alert onto another drive at once', () => {
    const shown = feed([light(null, 30, lowDisk('C', 5), 95)])
    expect(feed([light(null, 30, lowDisk('E', 3), 95)], shown).view?.storage).toEqual({ usedPercent: 95, lowDrive: 'E' })
  })

  it('without storage in the sample, usedPercent is null and the alert still shows', () => {
    expect(feed([light(null, 30, lowDisk('D', 4))]).view?.storage).toEqual({ usedPercent: null, lowDrive: 'D' })
    expect(feed([light(null)]).view?.storage).toEqual({ usedPercent: null, lowDrive: null })
  })

  it('drops the storage with the rest of the metrics when the monitor is lost', () => {
    const shown = feed([light(null, 30, NO_ALERTS, 62)])
    expect(feed([UNAVAILABLE, UNAVAILABLE], shown).view?.storage).toEqual({ usedPercent: 62, lowDrive: null })
    expect(feed([UNAVAILABLE, UNAVAILABLE, UNAVAILABLE], shown).view).toBeNull()
  })
  it("carries main's connectivity reading of each sample, unlatched, null included", () => {
    const offline = feed([light(null, 30, NO_ALERTS, null, false)])
    expect(offline.view?.online).toBe(false)
    expect(feed([light(null, 30, NO_ALERTS, null, true)], offline).view?.online).toBe(true)
    expect(feed([light(null, 30, NO_ALERTS, null, null)], offline).view?.online).toBeNull()
    // Unavailable samples keep the last view, its reading included, like the other metrics.
    expect(feed([UNAVAILABLE], offline).view?.online).toBe(false)
  })
})
