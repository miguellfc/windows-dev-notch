import { describe, expect, it } from 'vitest'
import { LIST_GRACE_MS, createProcessSampler } from '../../../src/main/system/process-sampler'
import type { ProcessEntry, ProcessInfo, SystemApi, TerminateResult } from '../../../src/main/system/win32-system'
import { PROCESS_LIMIT, processRowSchema } from '../../../src/shared/system/schema'

const SELF = 100
const SESSION = 1

interface Fake {
  api: SystemApi
  entries: ProcessEntry[]
  infos: Map<number, ProcessInfo | null>
  terminated: Array<{ pid: number; startTime: string }>
  terminateResult: TerminateResult
  clock: { t: number }
}

function info(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    cpuMs: 0,
    privateBytes: 1000,
    startTime: '2026-11-10T00:00:00.000Z',
    owner: 'self',
    critical: false,
    sessionId: SESSION,
    ...overrides,
  }
}

function fake(): Fake {
  const f: Fake = {
    entries: [],
    infos: new Map(),
    terminated: [],
    terminateResult: 'killed',
    clock: { t: 0 },
    api: undefined as unknown as SystemApi,
  }
  f.api = {
    cpuCount: 4,
    selfPid: SELF,
    selfSessionId: SESSION,
    systemTimes: () => null,
    memory: () => null,
    power: () => null,
    fixedDrives: () => [],
    diskSpace: () => null,
    diskIdlePercent: () => null,
    networkBytesPerSec: () => null,
    processes: () => f.entries,
    processInfo: (pid: number) => f.infos.get(pid) ?? null,
    terminate: (pid: number, startTime: string) => {
      f.terminated.push({ pid, startTime })
      return f.terminateResult
    },
    dispose: () => undefined,
  } satisfies SystemApi
  return f
}

function add(f: Fake, pid: number, i: ProcessInfo | null, parentPid = 1, name = `p${pid}`): void {
  f.entries.push({ pid, parentPid, name })
  f.infos.set(pid, i)
}

const sampler = (f: Fake) => createProcessSampler(f.api, () => f.clock.t)

describe('createProcessSampler', () => {
  describe('cpu', () => {
    it('is null on first sight and computed from deltas over cpuCount afterwards', () => {
      const f = fake()
      add(f, 10, info({ cpuMs: 1000 }))
      const s = sampler(f)
      expect(s.top('cpu')[0]?.cpuPercent).toBeNull()
      f.clock.t = 1000
      f.infos.set(10, info({ cpuMs: 3000 }))
      // 2000 ms of CPU over 1000 ms × 4 cores = 50 %
      expect(s.top('cpu')[0]?.cpuPercent).toBe(50)
    })

    it('rounds to one decimal and clamps to 0–100', () => {
      const f = fake()
      add(f, 10, info({ cpuMs: 0 }))
      add(f, 11, info({ cpuMs: 0, startTime: 'b' }))
      add(f, 12, info({ cpuMs: 5000, startTime: 'c' }))
      const s = sampler(f)
      s.top('cpu')
      f.clock.t = 3000
      f.infos.set(10, info({ cpuMs: 1000 })) // 1000 / 12000 = 8.333 %
      f.infos.set(11, info({ cpuMs: 99_999, startTime: 'b' }))
      f.infos.set(12, info({ cpuMs: 1000, startTime: 'c' })) // went backwards
      const rows = s.top('cpu')
      expect(rows.find((r) => r.pid === 10)?.cpuPercent).toBe(8.3)
      expect(rows.find((r) => r.pid === 11)?.cpuPercent).toBe(100)
      expect(rows.find((r) => r.pid === 12)?.cpuPercent).toBe(0)
    })

    it('treats a pid whose startTime changed as a new process', () => {
      const f = fake()
      add(f, 10, info({ cpuMs: 1000 }))
      const s = sampler(f)
      s.top('cpu')
      f.clock.t = 1000
      f.infos.set(10, info({ cpuMs: 2000, startTime: '2026-11-10T01:00:00.000Z' }))
      expect(s.top('cpu')[0]?.cpuPercent).toBeNull()
    })

    it('keeps the baseline and last value when called again within 500 ms', () => {
      const f = fake()
      add(f, 10, info({ cpuMs: 0 }))
      const s = sampler(f)
      s.top('cpu')
      f.clock.t = 100
      f.infos.set(10, info({ cpuMs: 400 }))
      expect(s.top('cpu')[0]?.cpuPercent).toBeNull() // no value yet, tiny Δt ignored
      f.clock.t = 1000
      f.infos.set(10, info({ cpuMs: 2000 }))
      expect(s.top('cpu')[0]?.cpuPercent).toBe(50) // measured against the t=0 baseline
      f.clock.t = 1100
      f.infos.set(10, info({ cpuMs: 2400 }))
      expect(s.top('ram')[0]?.cpuPercent).toBe(50) // last computed value reused
      f.clock.t = 2000
      f.infos.set(10, info({ cpuMs: 2400 }))
      expect(s.top('cpu')[0]?.cpuPercent).toBe(10) // 400 ms over 1000 ms × 4 against t=1000
    })

    it('reset() forgets the baseline', () => {
      const f = fake()
      add(f, 10, info({ cpuMs: 1000 }))
      const s = sampler(f)
      s.top('cpu')
      s.reset()
      f.clock.t = 1000
      f.infos.set(10, info({ cpuMs: 2000 }))
      expect(s.top('cpu')[0]?.cpuPercent).toBeNull()
    })
  })

  describe('ordering', () => {
    function threeProcesses(): { f: Fake; s: ReturnType<typeof createProcessSampler> } {
      const f = fake()
      add(f, 10, info({ cpuMs: 0, privateBytes: 300 }))
      add(f, 11, info({ cpuMs: 0, privateBytes: 100 }))
      add(f, 12, info({ cpuMs: 0, privateBytes: 200 }))
      const s = sampler(f)
      s.top('cpu')
      f.clock.t = 1000
      f.infos.set(10, info({ cpuMs: 400, privateBytes: 300 })) // 10 %
      f.infos.set(11, info({ cpuMs: 2000, privateBytes: 100 })) // 50 %
      f.infos.set(12, info({ cpuMs: 800, privateBytes: 200 })) // 20 %
      add(f, 13, info({ cpuMs: 0, privateBytes: 50, startTime: 'new' })) // first sight → null
      return { f, s }
    }

    it('sorts by cpu desc with null last', () => {
      const { s } = threeProcesses()
      expect(s.top('cpu').map((r) => r.pid)).toEqual([11, 12, 10, 13])
    })

    it('sorts by ram desc with null last', () => {
      const { f, s } = threeProcesses()
      add(f, 14, null)
      expect(s.top('ram').map((r) => r.pid)).toEqual([10, 12, 11, 13, 14])
    })

    it('breaks cpu ties by privateBytes desc then pid, and ram ties by cpu desc then pid', () => {
      const f = fake()
      add(f, 20, info({ privateBytes: 100 }))
      add(f, 21, info({ privateBytes: 500 }))
      add(f, 22, info({ privateBytes: 500 }))
      const s = sampler(f)
      expect(s.top('cpu').map((r) => r.pid)).toEqual([21, 22, 20])
      expect(s.top('ram').map((r) => r.pid)).toEqual([21, 22, 20])
    })

    it('limits to PROCESS_LIMIT (5) by default and honours a custom limit', () => {
      const f = fake()
      for (let pid = 10; pid < 20; pid++) add(f, pid, info({ privateBytes: pid }))
      const s = sampler(f)
      expect(s.top('ram')).toHaveLength(PROCESS_LIMIT)
      expect(s.top('ram', 3).map((r) => r.pid)).toEqual([19, 18, 17])
    })
  })

  describe('rows', () => {
    it('degrades a process whose info is unreadable to nulls and not killable', () => {
      const f = fake()
      add(f, 10, null)
      const [row] = sampler(f).top('cpu')
      expect(row).toMatchObject({ pid: 10, cpuPercent: null, privateBytes: null, killable: false })
    })

    it('produces rows that satisfy processRowSchema and truncates long names', () => {
      const f = fake()
      add(f, 10, info(), 1, 'x'.repeat(400))
      add(f, 11, null)
      add(f, 12, info({ privateBytes: null }))
      const rows = sampler(f).top('cpu')
      for (const row of rows) expect(() => processRowSchema.parse(row)).not.toThrow()
      expect(rows.find((r) => r.pid === 10)?.name).toHaveLength(260)
    })

    it('omits pid 0', () => {
      const f = fake()
      add(f, 0, info())
      add(f, 10, info())
      expect(sampler(f).top('cpu').map((r) => r.pid)).toEqual([10])
    })

    it('survives a throwing processes()', () => {
      const f = fake()
      f.api.processes = () => {
        throw new Error('snapshot failed')
      }
      expect(sampler(f).top('cpu')).toEqual([])
    })
  })

  describe('killable', () => {
    const killableOf = (f: Fake, pid: number): boolean | undefined =>
      sampler(f)
        .top('cpu', 50)
        .find((r) => r.pid === pid)?.killable

    it('is true for an own, non-critical process in the same session', () => {
      const f = fake()
      add(f, 10, info())
      expect(killableOf(f, 10)).toBe(true)
    })

    it.each([
      ['another user', { owner: 'other' as const }],
      ['unknown owner', { owner: 'unknown' as const }],
      ['critical', { critical: true }],
      ['another session', { sessionId: 2 }],
      ['unreadable session', { sessionId: -1 }],
    ])('is false for %s', (_label, overrides) => {
      const f = fake()
      add(f, 10, info(overrides))
      expect(killableOf(f, 10)).toBe(false)
    })

    it('is false for every process when the notch session is unreadable', () => {
      const f = fake()
      add(f, 10, info({ sessionId: -1 }))
      add(f, 11, info())
      f.api.selfSessionId = -1
      const rows = sampler(f).top('cpu', 50)
      expect(rows.every((r) => !r.killable)).toBe(true)
    })

    it('is false for the notch itself', () => {
      const f = fake()
      add(f, SELF, info())
      expect(killableOf(f, SELF)).toBe(false)
    })

    it('is false for pid 4 (System)', () => {
      const f = fake()
      add(f, 4, info())
      expect(killableOf(f, 4)).toBe(false)
    })

    it('is false for direct and transitive descendants of the notch', () => {
      const f = fake()
      add(f, SELF, info(), 1)
      add(f, 200, info(), SELF)
      add(f, 300, info(), 200)
      add(f, 400, info(), 1)
      const rows = sampler(f).top('cpu', 50)
      const byPid = new Map(rows.map((r) => [r.pid, r.killable]))
      expect(byPid.get(200)).toBe(false)
      expect(byPid.get(300)).toBe(false)
      expect(byPid.get(400)).toBe(true)
    })

    it('terminates on parent cycles without hanging', () => {
      const f = fake()
      add(f, 500, info(), 600)
      add(f, 600, info(), 500)
      add(f, 700, info(), 700)
      const rows = sampler(f).top('cpu', 50)
      expect(rows.every((r) => r.killable)).toBe(true)
    })
  })

  describe('kill', () => {
    const START = '2026-11-10T00:00:00.000Z'

    it('kills a killable process from the last list', () => {
      const f = fake()
      add(f, 10, info())
      const s = sampler(f)
      s.top('cpu')
      expect(s.kill({ pid: 10, startTime: START })).toBe('killed')
      expect(f.terminated).toEqual([{ pid: 10, startTime: START }])
    })

    it('refuses a pid that was not in the last list', () => {
      const f = fake()
      for (let pid = 10; pid < 20; pid++) add(f, pid, info({ privateBytes: pid }))
      const s = sampler(f)
      expect(s.kill({ pid: 19, startTime: START })).toBe('not-killable') // no top() yet
      s.top('ram')
      expect(s.kill({ pid: 10, startTime: START })).toBe('not-killable') // outside the top 5
      expect(s.kill({ pid: 999, startTime: START })).toBe('not-killable')
      expect(f.terminated).toEqual([])
    })

    it('refuses a startTime that differs from the listed one', () => {
      const f = fake()
      add(f, 10, info())
      const s = sampler(f)
      s.top('cpu')
      expect(s.kill({ pid: 10, startTime: '2026-11-10T09:00:00.000Z' })).toBe('not-killable')
      expect(f.terminated).toEqual([])
    })

    it('reports gone when the process disappeared or its pid was reused', () => {
      const f = fake()
      add(f, 10, info())
      add(f, 11, info())
      const s = sampler(f)
      s.top('cpu')
      f.infos.set(10, null)
      f.infos.set(11, info({ startTime: '2026-11-10T05:00:00.000Z' }))
      expect(s.kill({ pid: 10, startTime: START })).toBe('gone')
      expect(s.kill({ pid: 11, startTime: START })).toBe('gone')
      expect(f.terminated).toEqual([])
    })

    it('refuses a listed row that is not killable', () => {
      const f = fake()
      add(f, 10, info({ owner: 'other' }))
      const s = sampler(f)
      s.top('cpu')
      expect(s.kill({ pid: 10, startTime: START })).toBe('not-killable')
      expect(f.terminated).toEqual([])
    })

    it('revalidates and refuses a process that stopped being killable', () => {
      const f = fake()
      add(f, 10, info())
      add(f, 11, info())
      const s = sampler(f)
      s.top('cpu')
      f.infos.set(10, info({ critical: true }))
      f.entries.push({ pid: SELF, parentPid: 1, name: 'notch' })
      f.entries.find((e) => e.pid === 11)!.parentPid = SELF
      expect(s.kill({ pid: 10, startTime: START })).toBe('not-killable')
      expect(s.kill({ pid: 11, startTime: START })).toBe('not-killable')
      expect(f.terminated).toEqual([])
    })

    it('refuses when the fresh process snapshot fails (descendants cannot be ruled out)', () => {
      const f = fake()
      add(f, 10, info())
      const s = sampler(f)
      s.top('cpu')
      f.api.processes = () => {
        throw new Error('snapshot failed')
      }
      expect(s.kill({ pid: 10, startTime: START })).toBe('not-killable')
      expect(f.terminated).toEqual([])
    })

    it('refuses an empty startTime, a null-info row, the notch, pid 4 and a listed descendant', () => {
      const f = fake()
      add(f, SELF, info(), 1)
      add(f, 4, info(), 0)
      add(f, 200, info(), SELF)
      add(f, 10, null)
      const s = sampler(f)
      const rows = s.top('cpu', 50)
      expect(rows.find((r) => r.pid === 10)?.startTime).toBe('')
      expect(s.kill({ pid: 10, startTime: '' })).toBe('not-killable')
      expect(s.kill({ pid: SELF, startTime: START })).toBe('not-killable')
      expect(s.kill({ pid: 4, startTime: START })).toBe('not-killable')
      expect(s.kill({ pid: 200, startTime: START })).toBe('not-killable')
      expect(f.terminated).toEqual([])
    })

    it('reports gone when processInfo throws during kill', () => {
      const f = fake()
      add(f, 10, info())
      const s = sampler(f)
      s.top('cpu')
      f.api.processInfo = () => {
        throw new Error('open failed')
      }
      expect(s.kill({ pid: 10, startTime: START })).toBe('gone')
      expect(f.terminated).toEqual([])
    })

    it('reports denied when terminate throws', () => {
      const f = fake()
      add(f, 10, info())
      const s = sampler(f)
      s.top('cpu')
      f.api.terminate = () => {
        throw new Error('terminate failed')
      }
      expect(s.kill({ pid: 10, startTime: START })).toBe('denied')
    })

    it('propagates denied and gone from terminate', () => {
      const f = fake()
      add(f, 10, info())
      const s = sampler(f)
      s.top('cpu')
      f.terminateResult = 'denied'
      expect(s.kill({ pid: 10, startTime: START })).toBe('denied')
      f.terminateResult = 'gone'
      expect(s.kill({ pid: 10, startTime: START })).toBe('gone')
    })

    it('refuses when the fresh process snapshot comes back empty (the adapter failed)', () => {
      const f = fake()
      add(f, 10, info())
      const s = sampler(f)
      s.top('cpu')
      f.api.processes = () => []
      expect(s.kill({ pid: 10, startTime: START })).toBe('not-killable')
      expect(f.terminated).toEqual([])
    })

    it('still accepts a row that dropped out of the top list within the grace period', () => {
      const f = fake()
      for (let pid = 10; pid < 19; pid++) add(f, pid, info({ privateBytes: pid }))
      const s = sampler(f)
      s.top('ram') // 18..14: pid 14 is the last row (PROCESS_LIMIT = 5)
      f.clock.t = 1000
      f.infos.set(10, info({ privateBytes: 1_000_000 })) // pid 10 jumps in, pushing 14 out
      expect(s.top('ram').some((r) => r.pid === 14)).toBe(false)
      f.clock.t = LIST_GRACE_MS - 1
      expect(s.kill({ pid: 14, startTime: START })).toBe('killed')
      expect(f.terminated).toEqual([{ pid: 14, startTime: START }])
    })

    it('refuses a dropped row once the grace period is over', () => {
      const f = fake()
      for (let pid = 10; pid < 19; pid++) add(f, pid, info({ privateBytes: pid }))
      const s = sampler(f)
      s.top('ram')
      f.clock.t = 1000
      f.infos.set(10, info({ privateBytes: 1_000_000 }))
      s.top('ram')
      f.clock.t = LIST_GRACE_MS
      expect(s.kill({ pid: 14, startTime: START })).toBe('not-killable')
      // A later list drops the expired entry altogether.
      s.top('ram')
      f.clock.t = 1000
      expect(s.kill({ pid: 14, startTime: START })).toBe('not-killable')
      expect(f.terminated).toEqual([])
    })

    it('a grace row still goes through the fresh checks', () => {
      const f = fake()
      for (let pid = 10; pid < 19; pid++) add(f, pid, info({ privateBytes: pid }))
      const s = sampler(f)
      s.top('ram')
      f.clock.t = 1000
      f.infos.set(10, info({ privateBytes: 1_000_000 }))
      s.top('ram')
      f.infos.set(14, info({ privateBytes: 14, critical: true }))
      expect(s.kill({ pid: 14, startTime: START })).toBe('not-killable')
      f.infos.set(14, null)
      expect(s.kill({ pid: 14, startTime: START })).toBe('gone')
      expect(f.terminated).toEqual([])
    })

    it('forgetList() forgets the last list but keeps the CPU baselines', () => {
      const f = fake()
      add(f, 10, info({ cpuMs: 1000 }))
      const s = sampler(f)
      s.top('cpu')
      s.forgetList()
      expect(s.kill({ pid: 10, startTime: START })).toBe('not-killable')
      f.clock.t = 1000
      f.infos.set(10, info({ cpuMs: 3000 }))
      expect(s.top('cpu')[0]?.cpuPercent).toBe(50)
    })

    it('reset() forgets the last list', () => {
      const f = fake()
      add(f, 10, info())
      const s = sampler(f)
      s.top('cpu')
      s.reset()
      expect(s.kill({ pid: 10, startTime: START })).toBe('not-killable')
    })
  })
})
