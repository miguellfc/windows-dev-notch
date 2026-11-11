import os from 'node:os'
import type { Logger } from '../services/logger'
import { ensureKoffiType } from '../platform/koffi-types'

export interface ProcessEntry {
  pid: number
  parentPid: number
  name: string
}

export interface ProcessInfo {
  /** Kernel + user CPU time in milliseconds. */
  cpuMs: number
  /** Private commit in bytes; null when the memory read failed. */
  privateBytes: number | null
  /** Creation time as an ISO string (UTC); identifies the process together with the PID. */
  startTime: string
  owner: 'self' | 'other' | 'unknown'
  critical: boolean
  /** Terminal Services session; -1 when it could not be read. */
  sessionId: number
}

export type TerminateResult = 'killed' | 'gone' | 'denied'

export interface SystemApi {
  cpuCount: number
  selfPid: number
  selfSessionId: number
  systemTimes(): { idleMs: number; kernelMs: number; userMs: number } | null
  memory(): { totalBytes: number; availBytes: number } | null
  /** `charging`: the battery is charging (flag 8); `acOnline`: on AC power, charging or not (full on AC). */
  power(): { hasBattery: boolean; percent: number | null; charging: boolean; acOnline: boolean; secondsLeft: number | null } | null
  fixedDrives(): string[]
  diskSpace(letter: string): { totalBytes: number; freeBytes: number } | null
  diskIdlePercent(): number | null
  networkBytesPerSec(): { up: number; down: number } | null
  processes(): ProcessEntry[]
  processInfo(pid: number): ProcessInfo | null
  terminate(pid: number, startTime: string): TerminateResult
  dispose(): void
}

type Koffi = typeof import('koffi')

export interface FileTime {
  lo: number
  hi: number
}

interface StaticInfo {
  pid: number
  owner: ProcessInfo['owner']
  critical: boolean
  sessionId: number
}

interface PdhCycle {
  at: number
  diskIdle: number | null
  network: { up: number; down: number } | null
}

const PROCESS_TERMINATE = 0x1
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const TOKEN_QUERY = 0x8
const TOKEN_USER_CLASS = 1
const TH32CS_SNAPPROCESS = 0x2
const DRIVE_FIXED = 3
const ERROR_INVALID_PARAMETER = 87
const STILL_ACTIVE = 259
const PDH_FMT_DOUBLE = 0x200
const PDH_MORE_DATA = 0x800007d2
const PDH_CSTATUS_VALID_DATA = 0
const PDH_CSTATUS_NEW_DATA = 1
const PDH_REUSE_MS = 500
const INVALID_HANDLE = 0xffffffffffffffffn
const FILETIME_UNIX_EPOCH_MS = 11_644_473_600_000n

const toBig = (f: FileTime): bigint => (BigInt(f.hi >>> 0) << 32n) | BigInt(f.lo >>> 0)
const fileTimeMs = (f: FileTime): number => Number(toBig(f)) / 10_000
/** FILETIME (100 ns ticks since 1601-01-01 UTC) as an ISO-8601 instant, millisecond precision. */
export const fileTimeIso = (f: FileTime): string => new Date(Number(toBig(f) / 10_000n - FILETIME_UNIX_EPOCH_MS)).toISOString()
const hexStatus = (status: number): string => `0x${(status >>> 0).toString(16)}`
const emptyFileTime = (): FileTime => ({ lo: 0, hi: 0 })

function registerTypes(koffi: Koffi): void {
  ensureKoffiType(koffi, 'NOTCH_FILETIME', () => koffi.struct('NOTCH_FILETIME', { lo: 'uint32', hi: 'uint32' }))
  ensureKoffiType(koffi, 'NOTCH_MEMORYSTATUSEX', () =>
    koffi.struct('NOTCH_MEMORYSTATUSEX', {
      dwLength: 'uint32',
      dwMemoryLoad: 'uint32',
      ullTotalPhys: 'uint64',
      ullAvailPhys: 'uint64',
      ullTotalPageFile: 'uint64',
      ullAvailPageFile: 'uint64',
      ullTotalVirtual: 'uint64',
      ullAvailVirtual: 'uint64',
      ullAvailExtendedVirtual: 'uint64',
    }),
  )
  ensureKoffiType(koffi, 'NOTCH_SYSTEM_POWER_STATUS', () =>
    koffi.struct('NOTCH_SYSTEM_POWER_STATUS', {
      ACLineStatus: 'uint8',
      BatteryFlag: 'uint8',
      BatteryLifePercent: 'uint8',
      SystemStatusFlag: 'uint8',
      BatteryLifeTime: 'uint32',
      BatteryFullLifeTime: 'uint32',
    }),
  )
  ensureKoffiType(koffi, 'NOTCH_PROCESSENTRY32W', () =>
    koffi.struct('NOTCH_PROCESSENTRY32W', {
      dwSize: 'uint32',
      cntUsage: 'uint32',
      th32ProcessID: 'uint32',
      th32DefaultHeapID: 'uintptr_t',
      th32ModuleID: 'uint32',
      cntThreads: 'uint32',
      th32ParentProcessID: 'uint32',
      pcPriClassBase: 'int32',
      dwFlags: 'uint32',
      szExeFile: koffi.array('char16_t', 260, 'String'),
    }),
  )
  ensureKoffiType(koffi, 'NOTCH_PROCESS_MEMORY_COUNTERS_EX', () =>
    koffi.struct('NOTCH_PROCESS_MEMORY_COUNTERS_EX', {
      cb: 'uint32',
      PageFaultCount: 'uint32',
      PeakWorkingSetSize: 'size_t',
      WorkingSetSize: 'size_t',
      QuotaPeakPagedPoolUsage: 'size_t',
      QuotaPagedPoolUsage: 'size_t',
      QuotaPeakNonPagedPoolUsage: 'size_t',
      QuotaNonPagedPoolUsage: 'size_t',
      PagefileUsage: 'size_t',
      PeakPagefileUsage: 'size_t',
      PrivateUsage: 'size_t',
    }),
  )
  ensureKoffiType(koffi, 'NOTCH_PDH_FMT_COUNTERVALUE', () =>
    koffi.struct('NOTCH_PDH_FMT_COUNTERVALUE', { CStatus: 'uint32', doubleValue: 'double' }),
  )
  ensureKoffiType(koffi, 'NOTCH_PDH_FMT_COUNTERVALUE_ITEM_W', () =>
    koffi.struct('NOTCH_PDH_FMT_COUNTERVALUE_ITEM_W', { szName: 'str16', FmtValue: 'NOTCH_PDH_FMT_COUNTERVALUE' }),
  )
}

/**
 * Win32 + PDH reads for the system monitor (signatures validated in the Task 0 probe).
 * Returns null when koffi or a DLL cannot load. Each method degrades on its own: a throw
 * yields null / [] (or 'denied') for that call and is logged once per method.
 */
export function createWin32SystemApi(logger: Logger): SystemApi | null {
  const log = logger.child('system-monitor')
  try {
    // Loaded lazily so a broken native module never prevents startup.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as Koffi
    const kernel32 = koffi.load('kernel32.dll')
    const advapi32 = koffi.load('advapi32.dll')
    const pdh = koffi.load('pdh.dll')

    registerTypes(koffi)

    const GetSystemTimes = kernel32.func(
      'bool __stdcall GetSystemTimes(_Out_ NOTCH_FILETIME *idle, _Out_ NOTCH_FILETIME *kernel, _Out_ NOTCH_FILETIME *user)',
    )
    const GlobalMemoryStatusEx = kernel32.func('bool __stdcall GlobalMemoryStatusEx(_Inout_ NOTCH_MEMORYSTATUSEX *s)')
    const GetSystemPowerStatus = kernel32.func('bool __stdcall GetSystemPowerStatus(_Out_ NOTCH_SYSTEM_POWER_STATUS *s)')
    const GetLogicalDrives = kernel32.func('uint32 __stdcall GetLogicalDrives()')
    const GetDriveTypeW = kernel32.func('uint32 __stdcall GetDriveTypeW(str16 root)')
    const GetDiskFreeSpaceExW = kernel32.func(
      'bool __stdcall GetDiskFreeSpaceExW(str16 dir, _Out_ uint64 *avail, _Out_ uint64 *total, _Out_ uint64 *free)',
    )
    const CreateToolhelp32Snapshot = kernel32.func('void * __stdcall CreateToolhelp32Snapshot(uint32 flags, uint32 pid)')
    const Process32FirstW = kernel32.func('bool __stdcall Process32FirstW(void *snap, _Inout_ NOTCH_PROCESSENTRY32W *e)')
    const Process32NextW = kernel32.func('bool __stdcall Process32NextW(void *snap, _Inout_ NOTCH_PROCESSENTRY32W *e)')
    const OpenProcess = kernel32.func('void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)')
    const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *h)')
    const GetLastError = kernel32.func('uint32 __stdcall GetLastError()')
    const GetProcessTimes = kernel32.func(
      'bool __stdcall GetProcessTimes(void *h, _Out_ NOTCH_FILETIME *creation, _Out_ NOTCH_FILETIME *exit, _Out_ NOTCH_FILETIME *kernel, _Out_ NOTCH_FILETIME *user)',
    )
    const K32GetProcessMemoryInfo = kernel32.func(
      'bool __stdcall K32GetProcessMemoryInfo(void *h, _Out_ NOTCH_PROCESS_MEMORY_COUNTERS_EX *c, uint32 cb)',
    )
    const IsProcessCritical = kernel32.func('bool __stdcall IsProcessCritical(void *h, _Out_ int *critical)')
    const ProcessIdToSessionId = kernel32.func('bool __stdcall ProcessIdToSessionId(uint32 pid, _Out_ uint32 *session)')
    const GetCurrentProcess = kernel32.func('void * __stdcall GetCurrentProcess()')
    const GetExitCodeProcess = kernel32.func('bool __stdcall GetExitCodeProcess(void *h, _Out_ uint32 *code)')
    const TerminateProcess = kernel32.func('bool __stdcall TerminateProcess(void *h, uint32 code)')
    const OpenProcessToken = advapi32.func('bool __stdcall OpenProcessToken(void *h, uint32 access, _Out_ void **token)')
    const GetTokenInformation = advapi32.func(
      'bool __stdcall GetTokenInformation(void *token, int cls, _Out_ uint8_t *buf, uint32 len, _Out_ uint32 *ret)',
    )
    const EqualSid = advapi32.func('bool __stdcall EqualSid(void *a, void *b)')
    const PdhOpenQueryW = pdh.func('uint32 __stdcall PdhOpenQueryW(str16 source, uintptr_t user, _Out_ void **query)')
    const PdhAddEnglishCounterW = pdh.func(
      'uint32 __stdcall PdhAddEnglishCounterW(void *query, str16 path, uintptr_t user, _Out_ void **counter)',
    )
    const PdhCollectQueryData = pdh.func('uint32 __stdcall PdhCollectQueryData(void *query)')
    const PdhGetFormattedCounterValue = pdh.func(
      'uint32 __stdcall PdhGetFormattedCounterValue(void *counter, uint32 fmt, _Out_ uint32 *type, _Out_ NOTCH_PDH_FMT_COUNTERVALUE *value)',
    )
    const PdhGetFormattedCounterArrayW = pdh.func(
      'uint32 __stdcall PdhGetFormattedCounterArrayW(void *counter, uint32 fmt, _Inout_ uint32 *bufSize, _Out_ uint32 *count, _Out_ uint8_t *buf)',
    )
    const PdhCloseQuery = pdh.func('uint32 __stdcall PdhCloseQuery(void *query)')

    const memoryStatusSize = koffi.sizeof('NOTCH_MEMORYSTATUSEX')
    const processEntrySize = koffi.sizeof('NOTCH_PROCESSENTRY32W')
    const memoryCountersSize = koffi.sizeof('NOTCH_PROCESS_MEMORY_COUNTERS_EX')

    const failedMethods = new Set<string>()
    const guard = <T>(method: string, fallback: T, body: () => T): T => {
      try {
        return body()
      } catch (error) {
        if (!failedMethods.has(method)) {
          failedMethods.add(method)
          // Only the error message: never process names or other user data.
          log.warn(`${method} failed`, { error: error instanceof Error ? error.message : String(error) })
        }
        return fallback
      }
    }

    const isValidHandle = (handle: unknown): boolean => Boolean(handle) && koffi.address(handle) !== INVALID_HANDLE

    /** TokenUser buffer of the given process handle; the buffer must stay alive while the SID is used. */
    const tokenUser = (handle: unknown): { buf: Buffer; sid: unknown } | null => {
      const token: unknown[] = [null]
      if (!OpenProcessToken(handle, TOKEN_QUERY, token)) return null
      try {
        const needed = [0]
        GetTokenInformation(token[0], TOKEN_USER_CLASS, null, 0, needed)
        if (!needed[0]) return null
        const buf = Buffer.alloc(needed[0])
        if (!GetTokenInformation(token[0], TOKEN_USER_CLASS, buf, buf.length, needed)) return null
        return { buf, sid: koffi.decode(buf, 'void *') }
      } finally {
        CloseHandle(token[0])
      }
    }

    // Only a successful lookup is cached; a failure is retried on the next call.
    let selfToken: { buf: Buffer; sid: unknown } | null = null
    const selfSid = (): { buf: Buffer; sid: unknown } | null => {
      selfToken ??= tokenUser(GetCurrentProcess())
      return selfToken
    }

    const sessionOf = (pid: number): number => {
      const session = [0]
      return ProcessIdToSessionId(pid, session) ? (session[0] ?? -1) : -1
    }

    // Static per-process facts, keyed by `${pid}:${startTime}` so a reused PID never inherits them.
    const staticCache = new Map<string, StaticInfo>()

    const readStatic = (pid: number, handle: unknown): StaticInfo => {
      const self = selfSid()
      const user = tokenUser(handle)
      const owner: ProcessInfo['owner'] = self && user ? (EqualSid(user.sid, self.sid) ? 'self' : 'other') : 'unknown'
      const critical = [0]
      // Fail safe: if criticality cannot be read, treat the process as critical (never killable).
      const isCritical = IsProcessCritical(handle, critical) ? critical[0] !== 0 : true
      return { pid, owner, critical: isCritical, sessionId: sessionOf(pid) }
    }

    // PDH: one query opened lazily, shared by the disk and network getters.
    let pdhQuery: unknown = null
    let pdhBroken = false
    let diskCounter: unknown = null
    let sentCounter: unknown = null
    let receivedCounter: unknown = null
    let lastCycle: PdhCycle | null = null
    let collections = 0

    const openPdh = (): boolean => {
      if (pdhQuery) return true
      if (pdhBroken) return false
      const query: unknown[] = [null]
      const openStatus = (PdhOpenQueryW(null, 0, query) as number) >>> 0
      if (openStatus !== 0) {
        pdhBroken = true
        log.warn('PdhOpenQueryW failed; disk and network activity disabled', { status: hexStatus(openStatus) })
        return false
      }
      let addFailureLogged = false
      const add = (path: string): unknown => {
        const counter: unknown[] = [null]
        const status = (PdhAddEnglishCounterW(query[0], path, 0, counter) as number) >>> 0
        if (status === 0) return counter[0]
        if (!addFailureLogged) {
          addFailureLogged = true
          log.warn('PdhAddEnglishCounterW failed', { status: hexStatus(status) })
        }
        return null
      }
      pdhQuery = query[0]
      diskCounter = add('\\PhysicalDisk(_Total)\\% Idle Time')
      sentCounter = add('\\Network Interface(*)\\Bytes Sent/sec')
      receivedCounter = add('\\Network Interface(*)\\Bytes Received/sec')
      return true
    }

    const counterValue = (counter: unknown): number | null => {
      if (!counter) return null
      const value = { CStatus: 0, doubleValue: 0 }
      const status = PdhGetFormattedCounterValue(counter, PDH_FMT_DOUBLE, [0], value) as number
      if (status !== 0) return null
      if (value.CStatus !== PDH_CSTATUS_VALID_DATA && value.CStatus !== PDH_CSTATUS_NEW_DATA) return null
      return value.doubleValue
    }

    const counterArraySum = (counter: unknown): number | null => {
      if (!counter) return null
      for (let attempt = 0; attempt < 3; attempt++) {
        const size = [0]
        const count = [0]
        let status = (PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, size, count, null) as number) >>> 0
        if (status === 0) return 0 // no instances
        if (status !== PDH_MORE_DATA || !size[0]) return null
        const buf = Buffer.alloc(size[0])
        status = (PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, size, count, buf) as number) >>> 0
        if (status === PDH_MORE_DATA) continue // instances appeared between the two calls
        if (status !== 0) return null
        const items = koffi.decode(buf, koffi.array('NOTCH_PDH_FMT_COUNTERVALUE_ITEM_W', count[0] ?? 0)) as {
          FmtValue: { CStatus: number; doubleValue: number }
        }[]
        let sum = 0
        for (const item of items) {
          const ok = item.FmtValue.CStatus === PDH_CSTATUS_VALID_DATA || item.FmtValue.CStatus === PDH_CSTATUS_NEW_DATA
          if (ok && Number.isFinite(item.FmtValue.doubleValue)) sum += item.FmtValue.doubleValue
        }
        return sum
      }
      return null
    }

    /** At most one PdhCollectQueryData per 500 ms; both PDH getters read from the same cycle. */
    const collect = (): PdhCycle | null => {
      const now = Date.now()
      if (lastCycle && now - lastCycle.at < PDH_REUSE_MS) return lastCycle
      if (!openPdh()) return null
      if (PdhCollectQueryData(pdhQuery) !== 0) return null
      collections++
      // Rate counters need two collections: the first cycle after opening has no values.
      if (collections < 2) {
        lastCycle = { at: now, diskIdle: null, network: null }
        return lastCycle
      }
      const idle = counterValue(diskCounter)
      const up = counterArraySum(sentCounter)
      const down = counterArraySum(receivedCounter)
      // PDH can hand back NaN / Infinity (e.g. a counter wrap): treat it as "no value".
      const finite = (value: number | null): value is number => value !== null && Number.isFinite(value)
      lastCycle = {
        at: now,
        diskIdle: finite(idle) ? Math.min(100, Math.max(0, idle)) : null,
        network: finite(up) && finite(down) ? { up: Math.max(0, up), down: Math.max(0, down) } : null,
      }
      return lastCycle
    }

    const closePdh = (): void => {
      if (pdhQuery) PdhCloseQuery(pdhQuery)
      pdhQuery = null
      diskCounter = sentCounter = receivedCounter = null
      lastCycle = null
      collections = 0
    }

    const selfPid = process.pid
    const selfSessionId = guard('selfSessionId', -1, () => sessionOf(selfPid))

    return {
      cpuCount: os.cpus().length,
      selfPid,
      selfSessionId,

      systemTimes: () =>
        guard('systemTimes', null, () => {
          const idle = emptyFileTime()
          const kernel = emptyFileTime()
          const user = emptyFileTime()
          if (!GetSystemTimes(idle, kernel, user)) return null
          return { idleMs: fileTimeMs(idle), kernelMs: fileTimeMs(kernel), userMs: fileTimeMs(user) }
        }),

      memory: () =>
        guard('memory', null, () => {
          const status = { dwLength: memoryStatusSize } as { dwLength: number; ullTotalPhys?: number; ullAvailPhys?: number }
          if (!GlobalMemoryStatusEx(status)) return null
          return { totalBytes: Number(status.ullTotalPhys), availBytes: Number(status.ullAvailPhys) }
        }),

      power: () =>
        guard('power', null, () => {
          const status = { ACLineStatus: 0, BatteryFlag: 0, BatteryLifePercent: 0, BatteryLifeTime: 0 }
          if (!GetSystemPowerStatus(status)) return null
          const flag = status.BatteryFlag
          const lifeTime = status.BatteryLifeTime >>> 0
          return {
            hasBattery: (flag & 128) === 0,
            percent: status.BatteryLifePercent === 255 ? null : status.BatteryLifePercent,
            charging: flag !== 255 && (flag & 8) !== 0,
            acOnline: status.ACLineStatus === 1,
            secondsLeft: lifeTime === 0xffffffff ? null : lifeTime,
          }
        }),

      fixedDrives: () =>
        guard('fixedDrives', [], () => {
          const mask = (GetLogicalDrives() as number) >>> 0
          const letters: string[] = []
          for (let i = 0; i < 26; i++) {
            if (!(mask & (1 << i))) continue
            const letter = String.fromCharCode(65 + i)
            if (GetDriveTypeW(`${letter}:\\`) === DRIVE_FIXED) letters.push(letter)
          }
          return letters
        }),

      diskSpace: (letter) =>
        guard('diskSpace', null, () => {
          if (!/^[A-Za-z]$/.test(letter)) return null
          const avail = [0n]
          const total = [0n]
          const free = [0n]
          if (!GetDiskFreeSpaceExW(`${letter.toUpperCase()}:\\`, avail, total, free)) return null
          return { totalBytes: Number(total[0]), freeBytes: Number(free[0]) }
        }),

      diskIdlePercent: () => guard('diskIdlePercent', null, () => collect()?.diskIdle ?? null),

      networkBytesPerSec: () => guard('networkBytesPerSec', null, () => collect()?.network ?? null),

      processes: () =>
        guard('processes', [], () => {
          const snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
          if (!isValidHandle(snapshot)) return []
          const list: ProcessEntry[] = []
          try {
            const entry = { dwSize: processEntrySize, th32ProcessID: 0, th32ParentProcessID: 0, szExeFile: '' }
            let ok = Process32FirstW(snapshot, entry)
            while (ok) {
              list.push({ pid: entry.th32ProcessID, parentPid: entry.th32ParentProcessID, name: entry.szExeFile })
              ok = Process32NextW(snapshot, entry)
            }
          } finally {
            CloseHandle(snapshot)
          }
          const seen = new Set(list.map((p) => p.pid))
          for (const [key, info] of staticCache) {
            if (!seen.has(info.pid)) staticCache.delete(key)
          }
          return list
        }),

      processInfo: (pid) =>
        guard('processInfo', null, () => {
          const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
          if (!handle) return null
          try {
            const creation = emptyFileTime()
            const kernel = emptyFileTime()
            const user = emptyFileTime()
            if (!GetProcessTimes(handle, creation, emptyFileTime(), kernel, user)) return null
            const startTime = fileTimeIso(creation)
            const counters = { cb: memoryCountersSize, PrivateUsage: 0 }
            const privateBytes = K32GetProcessMemoryInfo(handle, counters, memoryCountersSize) ? Number(counters.PrivateUsage) : null
            const key = `${pid}:${startTime}`
            let info = staticCache.get(key)
            if (!info) {
              info = readStatic(pid, handle)
              // A new start time for this PID means it was reused: drop the stale entries.
              for (const [other, entry] of staticCache) {
                if (entry.pid === pid) staticCache.delete(other)
              }
              staticCache.set(key, info)
            }
            return {
              cpuMs: fileTimeMs(kernel) + fileTimeMs(user),
              privateBytes,
              startTime,
              owner: info.owner,
              critical: info.critical,
              sessionId: info.sessionId,
            }
          } finally {
            CloseHandle(handle)
          }
        }),

      terminate: (pid, startTime) =>
        guard<TerminateResult>('terminate', 'denied', () => {
          const handle = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
          if (!handle) return (GetLastError() as number) === ERROR_INVALID_PARAMETER ? 'gone' : 'denied'
          try {
            const creation = emptyFileTime()
            if (!GetProcessTimes(handle, creation, emptyFileTime(), emptyFileTime(), emptyFileTime())) return 'denied'
            // A different creation time means the PID was reused.
            if (fileTimeIso(creation) !== startTime) return 'gone'
            const exitCode = [0]
            if (GetExitCodeProcess(handle, exitCode) && exitCode[0] !== STILL_ACTIVE) return 'gone'
            return TerminateProcess(handle, 1) ? 'killed' : 'denied'
          } finally {
            CloseHandle(handle)
          }
        }),

      dispose: () => {
        guard('dispose', undefined, closePdh)
        staticCache.clear()
        selfToken = null
      },
    }
  } catch (error) {
    log.error('Win32 system bindings unavailable; system monitor disabled', { error })
    return null
  }
}
