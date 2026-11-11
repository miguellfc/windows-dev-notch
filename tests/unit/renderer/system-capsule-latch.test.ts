import { describe, expect, it } from 'vitest'
import { CAPSULE_MISSES, EMPTY_CAPSULE, nextCapsule, type CapsuleLatch } from '../../../src/renderer/notch/system/capsule-latch'
import type { SystemMetrics } from '../../../src/shared/system/schema'

const GB = 1024 ** 3
const light = (battery: { percent: number; charging: boolean; pluggedIn: boolean } | null, cpuPercent: number | null = 30): SystemMetrics => ({
  kind: 'light',
  cpuPercent,
  ram: { usedBytes: 8 * GB, totalBytes: 16 * GB },
  battery: battery && { ...battery, secondsLeft: null },
})
const UNAVAILABLE: SystemMetrics = { kind: 'unavailable' }
const feed = (samples: SystemMetrics[], from: CapsuleLatch = EMPTY_CAPSULE): CapsuleLatch => samples.reduce(nextCapsule, from)

describe('nextCapsule', () => {
  it('starts with nothing to show, and shows the first sample at once', () => {
    expect(EMPTY_CAPSULE.view).toBeNull()
    expect(feed([light({ percent: 82, charging: true, pluggedIn: true })]).view).toEqual({
      cpuPercent: 30,
      ramPercent: 50,
      battery: { percent: 82, charging: true, pluggedIn: true },
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
    }
    expect(feed([full]).view).toEqual({ cpuPercent: 30, ramPercent: 50, battery: null })
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
    })
  })

  it('stays empty when the monitor is unavailable from the start', () => {
    expect(feed([UNAVAILABLE]).view).toBeNull()
  })

  it('treats an empty RAM total as unknown', () => {
    const sample: SystemMetrics = { kind: 'light', cpuPercent: null, ram: { usedBytes: 0, totalBytes: 0 }, battery: null }
    expect(feed([sample]).view).toEqual({ cpuPercent: null, ramPercent: null, battery: null })
  })
})
