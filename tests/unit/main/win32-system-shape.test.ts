import { createRequire } from 'node:module'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWin32SystemApi, fileTimeIso } from '../../../src/main/system/win32-system'
import { createMemoryLogger } from '../helpers/memory-logger'

// Every native call reports failure (returns false / null).
const library = { func: vi.fn(() => vi.fn(() => false)) }
const koffiMock = {
  load: vi.fn((): unknown => library),
  type: vi.fn(),
  struct: vi.fn(),
  array: vi.fn(),
  sizeof: vi.fn(() => 8),
  decode: vi.fn(),
  address: vi.fn(() => 0n),
}

// The adapter loads koffi lazily with CommonJS `require`, which vi.mock does not intercept,
// so the mock is installed in Node's require cache under koffi's resolved path instead.
const nodeRequire = createRequire(import.meta.url)
const koffiPath = nodeRequire.resolve('koffi')
let realEntry: NodeJS.Module | undefined

beforeAll(() => {
  realEntry = nodeRequire.cache[koffiPath]
  nodeRequire.cache[koffiPath] = { id: koffiPath, filename: koffiPath, loaded: true, exports: koffiMock } as NodeJS.Module
})

afterAll(() => {
  if (realEntry) nodeRequire.cache[koffiPath] = realEntry
  else delete nodeRequire.cache[koffiPath]
})

const MEMBERS = [
  'systemTimes',
  'memory',
  'power',
  'fixedDrives',
  'diskSpace',
  'diskIdlePercent',
  'networkBytesPerSec',
  'processes',
  'processInfo',
  'terminate',
  'dispose',
] as const

describe('createWin32SystemApi (koffi mocked)', () => {
  beforeEach(() => {
    koffiMock.load.mockClear()
  })

  it('returns null and logs when koffi.load throws', () => {
    koffiMock.load.mockImplementationOnce(() => {
      throw new Error('dll missing')
    })
    const logger = createMemoryLogger()
    expect(createWin32SystemApi(logger)).toBeNull()
    expect(logger.entries.some((e) => e.level === 'error')).toBe(true)
  })

  it('exposes every SystemApi member', () => {
    const api = createWin32SystemApi(createMemoryLogger())
    expect(api).not.toBeNull()
    for (const member of MEMBERS) expect(typeof api?.[member]).toBe('function')
    expect(api?.selfPid).toBe(process.pid)
    expect(typeof api?.selfSessionId).toBe('number')
    expect(api?.cpuCount).toBeGreaterThan(0)
  })

  it('degrades per method when the native calls fail', () => {
    const api = createWin32SystemApi(createMemoryLogger())
    expect(api?.systemTimes()).toBeNull()
    expect(api?.memory()).toBeNull()
    expect(api?.processInfo(1234)).toBeNull()
    expect(api?.fixedDrives()).toEqual([])
    expect(api?.diskSpace('not a letter')).toBeNull()
  })
})

describe('fileTimeIso', () => {
  /** Splits an ISO instant into a FILETIME (100 ns ticks since 1601), plus extra sub-ms ticks. */
  const toFileTime = (iso: string, extraTicks = 0n) => {
    const ticks = (BigInt(Date.parse(iso)) + 11_644_473_600_000n) * 10_000n + extraTicks
    return { lo: Number(ticks & 0xffffffffn), hi: Number(ticks >> 32n) }
  }

  it('round-trips an ISO instant through a FILETIME', () => {
    for (const iso of ['2026-11-11T08:30:15.123Z', '1970-01-01T00:00:00.000Z', '2001-09-09T01:46:40.999Z']) {
      expect(fileTimeIso(toFileTime(iso))).toBe(iso)
    }
  })

  it('truncates sub-millisecond ticks and reads lo as unsigned', () => {
    expect(fileTimeIso(toFileTime('2026-11-11T08:30:15.123Z', 9_999n))).toBe('2026-11-11T08:30:15.123Z')
    const time = toFileTime('2026-11-11T08:30:15.123Z')
    // koffi may hand back a uint32 as a negative int32: the result must not change.
    expect(fileTimeIso({ lo: time.lo | 0, hi: time.hi })).toBe('2026-11-11T08:30:15.123Z')
  })
})
