import { describe, expect, it } from 'vitest'
import { createMetricsSampler } from '../../../src/main/system/metrics-sampler'
import type { SystemApi } from '../../../src/main/system/win32-system'
import { NO_ALERTS, fullSampleSchema, lightSampleSchema } from '../../../src/shared/system/schema'

type Times = { idleMs: number; kernelMs: number; userMs: number } | null

interface Fake {
  api: SystemApi
  state: {
    times: Times
    memory: { totalBytes: number; availBytes: number } | null
    power: { hasBattery: boolean; percent: number | null; charging: boolean; acOnline: boolean; secondsLeft: number | null } | null
    drives: string[] | null
    space: Record<string, { totalBytes: number; freeBytes: number } | null>
    diskIdle: number | null
    network: { up: number; down: number } | null
    throwing: Set<string>
  }
}

function fakeApi(): Fake {
  const state: Fake['state'] = {
    times: { idleMs: 0, kernelMs: 0, userMs: 0 },
    memory: { totalBytes: 16_000, availBytes: 4_000 },
    power: { hasBattery: true, percent: 80, charging: false, acOnline: false, secondsLeft: 3600 },
    drives: ['C'],
    space: { C: { totalBytes: 1000, freeBytes: 250 } },
    diskIdle: 90,
    network: { up: 100, down: 200 },
    throwing: new Set(),
  }
  const read = <T>(name: string, value: () => T): T => {
    if (state.throwing.has(name)) throw new Error(`${name} failed`)
    return value()
  }
  const api = {
    cpuCount: 8,
    selfPid: 1,
    selfSessionId: 1,
    systemTimes: () => read('systemTimes', () => state.times),
    memory: () => read('memory', () => state.memory),
    power: () => read('power', () => state.power),
    fixedDrives: () => read('fixedDrives', () => state.drives),
    diskSpace: (letter: string) => read('diskSpace', () => state.space[letter] ?? null),
    diskIdlePercent: () => read('diskIdlePercent', () => state.diskIdle),
    networkBytesPerSec: () => read('networkBytesPerSec', () => state.network),
    processes: () => [],
    processInfo: () => null,
    terminate: () => 'denied' as const,
    dispose: () => undefined,
  } satisfies SystemApi
  return { api, state }
}

describe('createMetricsSampler', () => {
  describe('cpu', () => {
    it('is null on the first sample and computed from deltas afterwards', () => {
      const { api, state } = fakeApi()
      const sampler = createMetricsSampler(api)
      state.times = { idleMs: 100, kernelMs: 200, userMs: 100 }
      expect(sampler.light().cpuPercent).toBeNull()
      // Δidle 50, Δkernel 100 (includes idle), Δuser 100 → total 200, busy 150 → 75
      state.times = { idleMs: 150, kernelMs: 300, userMs: 200 }
      expect(sampler.light().cpuPercent).toBe(75)
    })

    it('rounds to an integer', () => {
      const { api, state } = fakeApi()
      const sampler = createMetricsSampler(api)
      state.times = { idleMs: 0, kernelMs: 0, userMs: 0 }
      sampler.light()
      // total 3, idle 1 → 66.67 → 67
      state.times = { idleMs: 1, kernelMs: 2, userMs: 1 }
      expect(sampler.light().cpuPercent).toBe(67)
    })

    it('is null again on the first sample after reset()', () => {
      const { api, state } = fakeApi()
      const sampler = createMetricsSampler(api)
      sampler.light()
      state.times = { idleMs: 50, kernelMs: 100, userMs: 100 }
      expect(sampler.light().cpuPercent).not.toBeNull()
      sampler.reset()
      state.times = { idleMs: 100, kernelMs: 200, userMs: 200 }
      expect(sampler.light().cpuPercent).toBeNull()
    })

    it('repeats the last value when the total delta is 0', () => {
      const { api, state } = fakeApi()
      const sampler = createMetricsSampler(api)
      sampler.light()
      state.times = { idleMs: 50, kernelMs: 100, userMs: 100 }
      expect(sampler.light().cpuPercent).toBe(75)
      expect(sampler.light().cpuPercent).toBe(75)
    })

    it('is null when systemTimes is unavailable or throws, without breaking the rest', () => {
      const { api, state } = fakeApi()
      const sampler = createMetricsSampler(api)
      state.times = null
      expect(sampler.light().cpuPercent).toBeNull()
      state.throwing.add('systemTimes')
      const sample = sampler.light()
      expect(sample.cpuPercent).toBeNull()
      expect(sample.ram).not.toBeNull()
    })
  })

  describe('cpu baseline', () => {
    it('keeps the baseline across a null systemTimes read', () => {
      const { api, state } = fakeApi()
      const sampler = createMetricsSampler(api)
      state.times = { idleMs: 100, kernelMs: 200, userMs: 100 }
      sampler.light()
      state.times = null
      expect(sampler.light().cpuPercent).toBeNull()
      // Delta against the read before the failure: Δidle 50, Δtotal 200 → 75.
      state.times = { idleMs: 150, kernelMs: 300, userMs: 200 }
      expect(sampler.light().cpuPercent).toBe(75)
    })

    it('keeps the baseline across a NaN systemTimes read', () => {
      const { api, state } = fakeApi()
      const sampler = createMetricsSampler(api)
      state.times = { idleMs: 100, kernelMs: 200, userMs: 100 }
      sampler.light()
      state.times = { idleMs: Number.NaN, kernelMs: 300, userMs: 200 }
      expect(sampler.light().cpuPercent).toBeNull()
      state.times = { idleMs: 150, kernelMs: 300, userMs: 200 }
      expect(sampler.light().cpuPercent).toBe(75)
    })
  })

  describe('non-finite readings', () => {
    it('a NaN disk idle counter nulls only disk activity and the sample still parses', () => {
      const { api, state } = fakeApi()
      const sampler = createMetricsSampler(api)
      state.diskIdle = Number.NaN
      const sample = sampler.full()
      expect(sample.disks).toEqual([{ letter: 'C', usedPercent: 75, freeBytes: 250, activityPercent: null }])
      expect(sample.network).toEqual({ upBytesPerSec: 100, downBytesPerSec: 200 })
      expect(sample.ram).not.toBeNull()
      expect(fullSampleSchema.safeParse({ ...sample, alerts: NO_ALERTS }).success).toBe(true)
    })

    it('a non-finite network rate nulls only the network', () => {
      const { api, state } = fakeApi()
      state.network = { up: Number.POSITIVE_INFINITY, down: 3 }
      const sample = createMetricsSampler(api).full()
      expect(sample.network).toBeNull()
      expect(sample.disks).toHaveLength(1)
      expect(fullSampleSchema.safeParse({ ...sample, alerts: NO_ALERTS }).success).toBe(true)
    })

    it('non-finite memory or disk space drops only that metric', () => {
      const { api, state } = fakeApi()
      state.memory = { totalBytes: Number.NaN, availBytes: 1 }
      state.space = { C: { totalBytes: Number.NaN, freeBytes: 1 } }
      const sample = createMetricsSampler(api).full()
      expect(sample.ram).toBeNull()
      expect(sample.disks).toEqual([])
      expect(sample.network).not.toBeNull()
      expect(fullSampleSchema.safeParse({ ...sample, alerts: NO_ALERTS }).success).toBe(true)
    })
  })

  describe('ram', () => {
    it('uses total minus available', () => {
      const { api } = fakeApi()
      expect(createMetricsSampler(api).light().ram).toEqual({ usedBytes: 12_000, totalBytes: 16_000 })
    })

    it('is null when unavailable or throwing', () => {
      const { api, state } = fakeApi()
      const sampler = createMetricsSampler(api)
      state.memory = null
      expect(sampler.light().ram).toBeNull()
      state.memory = { totalBytes: 1, availBytes: 1 }
      state.throwing.add('memory')
      expect(sampler.light().ram).toBeNull()
    })
  })

  describe('battery', () => {
    it('maps the power status', () => {
      const { api, state } = fakeApi()
      state.power = { hasBattery: true, percent: 55, charging: true, acOnline: true, secondsLeft: null }
      expect(createMetricsSampler(api).light().battery).toEqual({ percent: 55, charging: true, pluggedIn: true, secondsLeft: null })
    })

    it('is null without a battery, with a null percent, when null or throwing', () => {
      const { api, state } = fakeApi()
      const sampler = createMetricsSampler(api)
      state.power = { hasBattery: false, percent: 100, charging: true, acOnline: true, secondsLeft: null }
      expect(sampler.light().battery).toBeNull()
      state.power = { hasBattery: true, percent: null, charging: false, acOnline: false, secondsLeft: null }
      expect(sampler.light().battery).toBeNull()
      state.power = null
      expect(sampler.light().battery).toBeNull()
      state.power = { hasBattery: true, percent: 50, charging: false, acOnline: false, secondsLeft: 10 }
      state.throwing.add('power')
      expect(sampler.light().battery).toBeNull()
    })

    it('reports plugged in but not charging when full on AC', () => {
      const { api, state } = fakeApi()
      state.power = { hasBattery: true, percent: 100, charging: false, acOnline: true, secondsLeft: null }
      expect(createMetricsSampler(api).light().battery).toEqual({ percent: 100, charging: false, pluggedIn: true, secondsLeft: null })
    })

    it('is null for a non-finite percent', () => {
      const { api, state } = fakeApi()
      state.power = { hasBattery: true, percent: Number.NaN, charging: false, acOnline: false, secondsLeft: null }
      expect(createMetricsSampler(api).light().battery).toBeNull()
    })

    it('clamps and rounds the percent to 0-100', () => {
      const { api, state } = fakeApi()
      const sampler = createMetricsSampler(api)
      state.power = { hasBattery: true, percent: 140, charging: false, acOnline: false, secondsLeft: null }
      expect(sampler.light().battery?.percent).toBe(100)
      state.power = { hasBattery: true, percent: -5, charging: false, acOnline: false, secondsLeft: null }
      expect(sampler.light().battery?.percent).toBe(0)
    })
  })

  describe('disks', () => {
    it('lists only fixed drives with a rounded usedPercent and activity = 100 - idle', () => {
      const { api, state } = fakeApi()
      state.drives = ['C', 'D']
      state.space = {
        C: { totalBytes: 3, freeBytes: 1 },
        D: { totalBytes: 1000, freeBytes: 1000 },
        E: { totalBytes: 10, freeBytes: 0 },
      }
      state.diskIdle = 62.4
      expect(createMetricsSampler(api).full().disks).toEqual([
        { letter: 'C', usedPercent: 67, freeBytes: 1, activityPercent: 38 },
        { letter: 'D', usedPercent: 0, freeBytes: 1000, activityPercent: 38 },
      ])
    })

    it('uses 0 usedPercent when total is 0 and skips drives without space info', () => {
      const { api, state } = fakeApi()
      state.drives = ['C', 'D']
      state.space = { C: { totalBytes: 0, freeBytes: 0 }, D: null }
      expect(createMetricsSampler(api).full().disks).toEqual([
        { letter: 'C', usedPercent: 0, freeBytes: 0, activityPercent: 10 },
      ])
    })

    it('has null activity on every disk when diskIdlePercent is null', () => {
      const { api, state } = fakeApi()
      state.drives = ['C', 'D']
      state.space.D = { totalBytes: 10, freeBytes: 5 }
      state.diskIdle = null
      expect(createMetricsSampler(api).full().disks.map((d) => d.activityPercent)).toEqual([null, null])
    })

    it('clamps activity to 0-100', () => {
      const { api, state } = fakeApi()
      state.diskIdle = 120
      expect(createMetricsSampler(api).full().disks[0]?.activityPercent).toBe(0)
      state.diskIdle = -10
      expect(createMetricsSampler(api).full().disks[0]?.activityPercent).toBe(100)
    })

    it('degrades to an empty list when fixedDrives or diskSpace throw', () => {
      const { api, state } = fakeApi()
      const sampler = createMetricsSampler(api)
      state.throwing.add('fixedDrives')
      expect(sampler.full().disks).toEqual([])
      state.throwing.delete('fixedDrives')
      state.throwing.add('diskSpace')
      expect(sampler.full().disks).toEqual([])
    })

    it('keeps disks but nulls activity when diskIdlePercent throws', () => {
      const { api, state } = fakeApi()
      state.throwing.add('diskIdlePercent')
      expect(createMetricsSampler(api).full().disks).toEqual([
        { letter: 'C', usedPercent: 75, freeBytes: 250, activityPercent: null },
      ])
    })
  })

  describe('disks() (space only)', () => {
    it('reports rounded free percent per fixed drive without touching PDH', () => {
      const { api, state } = fakeApi()
      state.drives = ['C', 'D']
      state.space = { C: { totalBytes: 3, freeBytes: 1 }, D: { totalBytes: 1000, freeBytes: 1000 } }
      state.throwing.add('diskIdlePercent')
      state.throwing.add('systemTimes')
      expect(createMetricsSampler(api).disks()).toEqual([
        { letter: 'C', freePercent: 33 },
        { letter: 'D', freePercent: 100 },
      ])
    })

    it('skips drives with total 0, no space info or non-finite numbers, and clamps to 0-100', () => {
      const { api, state } = fakeApi()
      state.drives = ['C', 'D', 'E', 'F', 'G']
      state.space = {
        C: { totalBytes: 0, freeBytes: 0 },
        D: null,
        E: { totalBytes: Number.NaN, freeBytes: 1 },
        F: { totalBytes: 10, freeBytes: 20 },
        G: { totalBytes: 10, freeBytes: 1 },
      }
      expect(createMetricsSampler(api).disks()).toEqual([
        { letter: 'F', freePercent: 100 },
        { letter: 'G', freePercent: 10 },
      ])
    })

    it('is null (keep the last reading) when the drive list cannot be read, empty when diskSpace throws', () => {
      const { api, state } = fakeApi()
      const sampler = createMetricsSampler(api)
      state.throwing.add('fixedDrives')
      expect(sampler.disks()).toBeNull()
      state.throwing.delete('fixedDrives')
      state.drives = null
      expect(sampler.disks()).toBeNull()
      state.drives = ['C']
      state.throwing.add('diskSpace')
      expect(sampler.disks()).toEqual([])
    })

    it('does not disturb the CPU baseline', () => {
      const { api, state } = fakeApi()
      const sampler = createMetricsSampler(api)
      sampler.light()
      state.times = { idleMs: 50, kernelMs: 100, userMs: 100 }
      sampler.disks()
      expect(sampler.light().cpuPercent).toBe(75)
    })
  })

  describe('network', () => {
    it('maps up/down to rounded integers', () => {
      const { api, state } = fakeApi()
      state.network = { up: 10.6, down: 2000.4 }
      expect(createMetricsSampler(api).full().network).toEqual({ upBytesPerSec: 11, downBytesPerSec: 2000 })
    })

    it('is null when unavailable or throwing', () => {
      const { api, state } = fakeApi()
      const sampler = createMetricsSampler(api)
      state.network = null
      expect(sampler.full().network).toBeNull()
      state.network = { up: 1, down: 1 }
      state.throwing.add('networkBytesPerSec')
      expect(sampler.full().network).toBeNull()
    })
  })

  describe('shape', () => {
    it('light() has no disks or network; full() extends it', () => {
      const { api } = fakeApi()
      const sampler = createMetricsSampler(api)
      expect(Object.keys(sampler.light()).sort()).toEqual(['battery', 'cpuPercent', 'ram'])
      expect(Object.keys(sampler.full()).sort()).toEqual(['battery', 'cpuPercent', 'disks', 'network', 'ram'])
    })

    it('every sample passes the zod schemas', () => {
      const { api, state } = fakeApi()
      const sampler = createMetricsSampler(api)
      const check = (): void => {
        expect(lightSampleSchema.safeParse({ ...sampler.light(), alerts: NO_ALERTS }).success).toBe(true)
        expect(fullSampleSchema.safeParse({ ...sampler.full(), alerts: NO_ALERTS }).success).toBe(true)
      }
      check()
      state.times = { idleMs: 70, kernelMs: 200, userMs: 100 }
      state.power = { hasBattery: true, percent: 200, charging: true, acOnline: true, secondsLeft: 120 }
      state.network = { up: 5.5, down: 0 }
      state.diskIdle = 150
      check()
      state.memory = null
      state.power = null
      state.network = null
      state.diskIdle = null
      state.drives = []
      check()
      state.throwing = new Set([
        'systemTimes',
        'memory',
        'power',
        'fixedDrives',
        'diskSpace',
        'diskIdlePercent',
        'networkBytesPerSec',
      ])
      check()
    })
  })
})
