'use strict'
// Throwaway feasibility probe for the System Monitor (Task 0). Run: node spikes/system-monitor/probe.cjs
const koffi = require('koffi')
const { spawn } = require('node:child_process')
const os = require('node:os')
const hr = () => process.hrtime.bigint()
const ms = (a, b) => Number(b - a) / 1e6
const stats = (a) => ({
  mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3),
  max: +Math.max(...a).toFixed(3),
  min: +Math.min(...a).toFixed(3),
})
const sleep = (t) => new Promise((r) => setTimeout(r, t))

const k32 = koffi.load('kernel32.dll')
const adv = koffi.load('advapi32.dll')
const pdh = koffi.load('pdh.dll')

const FILETIME = koffi.struct('NOTCH_FILETIME', { lo: 'uint32', hi: 'uint32' })
const MEMORYSTATUSEX = koffi.struct('NOTCH_MEMORYSTATUSEX', {
  dwLength: 'uint32', dwMemoryLoad: 'uint32', ullTotalPhys: 'uint64', ullAvailPhys: 'uint64',
  ullTotalPageFile: 'uint64', ullAvailPageFile: 'uint64', ullTotalVirtual: 'uint64', ullAvailVirtual: 'uint64',
  ullAvailExtendedVirtual: 'uint64',
})
koffi.struct('NOTCH_SYSTEM_POWER_STATUS', {
  ACLineStatus: 'uint8', BatteryFlag: 'uint8', BatteryLifePercent: 'uint8', SystemStatusFlag: 'uint8',
  BatteryLifeTime: 'uint32', BatteryFullLifeTime: 'uint32',
})
const PROCESSENTRY32W = koffi.struct('NOTCH_PROCESSENTRY32W', {
  dwSize: 'uint32', cntUsage: 'uint32', th32ProcessID: 'uint32', th32DefaultHeapID: 'uintptr_t', th32ModuleID: 'uint32',
  cntThreads: 'uint32', th32ParentProcessID: 'uint32', pcPriClassBase: 'int32', dwFlags: 'uint32',
  szExeFile: koffi.array('char16_t', 260, 'String'),
})
const PMC = koffi.struct('NOTCH_PROCESS_MEMORY_COUNTERS_EX', {
  cb: 'uint32', PageFaultCount: 'uint32', PeakWorkingSetSize: 'size_t', WorkingSetSize: 'size_t',
  QuotaPeakPagedPoolUsage: 'size_t', QuotaPagedPoolUsage: 'size_t', QuotaPeakNonPagedPoolUsage: 'size_t',
  QuotaNonPagedPoolUsage: 'size_t', PagefileUsage: 'size_t', PeakPagefileUsage: 'size_t', PrivateUsage: 'size_t',
})
const PDH_VALUE = koffi.struct('NOTCH_PDH_FMT_COUNTERVALUE', { CStatus: 'uint32', doubleValue: 'double' })
const PDH_ITEM = koffi.struct('NOTCH_PDH_FMT_COUNTERVALUE_ITEM_W', { szName: 'str16', FmtValue: PDH_VALUE })

const GetSystemTimes = k32.func('bool __stdcall GetSystemTimes(_Out_ NOTCH_FILETIME *idle, _Out_ NOTCH_FILETIME *kernel, _Out_ NOTCH_FILETIME *user)')
const GlobalMemoryStatusEx = k32.func('bool __stdcall GlobalMemoryStatusEx(_Inout_ NOTCH_MEMORYSTATUSEX *s)')
const GetSystemPowerStatus = k32.func('bool __stdcall GetSystemPowerStatus(_Out_ NOTCH_SYSTEM_POWER_STATUS *s)')
const GetLogicalDrives = k32.func('uint32 __stdcall GetLogicalDrives()')
const GetDriveTypeW = k32.func('uint32 __stdcall GetDriveTypeW(str16 root)')
const GetDiskFreeSpaceExW = k32.func('bool __stdcall GetDiskFreeSpaceExW(str16 dir, _Out_ uint64 *avail, _Out_ uint64 *total, _Out_ uint64 *free)')
const CreateToolhelp32Snapshot = k32.func('void * __stdcall CreateToolhelp32Snapshot(uint32 flags, uint32 pid)')
const Process32FirstW = k32.func('bool __stdcall Process32FirstW(void *snap, _Inout_ NOTCH_PROCESSENTRY32W *e)')
const Process32NextW = k32.func('bool __stdcall Process32NextW(void *snap, _Inout_ NOTCH_PROCESSENTRY32W *e)')
const OpenProcess = k32.func('void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)')
const CloseHandle = k32.func('bool __stdcall CloseHandle(void *h)')
const GetProcessTimes = k32.func('bool __stdcall GetProcessTimes(void *h, _Out_ NOTCH_FILETIME *creation, _Out_ NOTCH_FILETIME *exit, _Out_ NOTCH_FILETIME *kernel, _Out_ NOTCH_FILETIME *user)')
const K32GetProcessMemoryInfo = k32.func('bool __stdcall K32GetProcessMemoryInfo(void *h, _Out_ NOTCH_PROCESS_MEMORY_COUNTERS_EX *c, uint32 cb)')
const IsProcessCritical = k32.func('bool __stdcall IsProcessCritical(void *h, _Out_ int *critical)')
const ProcessIdToSessionId = k32.func('bool __stdcall ProcessIdToSessionId(uint32 pid, _Out_ uint32 *session)')
const GetCurrentProcess = k32.func('void * __stdcall GetCurrentProcess()')
const TerminateProcess = k32.func('bool __stdcall TerminateProcess(void *h, uint32 code)')
const OpenProcessToken = adv.func('bool __stdcall OpenProcessToken(void *h, uint32 access, _Out_ void **token)')
const GetTokenInformation = adv.func('bool __stdcall GetTokenInformation(void *token, int cls, _Out_ uint8_t *buf, uint32 len, _Out_ uint32 *ret)')
const EqualSid = adv.func('bool __stdcall EqualSid(void *a, void *b)')
const PdhOpenQueryW = pdh.func('uint32 __stdcall PdhOpenQueryW(str16 source, uintptr_t user, _Out_ void **query)')
const PdhAddEnglishCounterW = pdh.func('uint32 __stdcall PdhAddEnglishCounterW(void *query, str16 path, uintptr_t user, _Out_ void **counter)')
const PdhCollectQueryData = pdh.func('uint32 __stdcall PdhCollectQueryData(void *query)')
const PdhGetFormattedCounterValue = pdh.func('uint32 __stdcall PdhGetFormattedCounterValue(void *counter, uint32 fmt, _Out_ uint32 *type, _Out_ NOTCH_PDH_FMT_COUNTERVALUE *value)')
const PdhGetFormattedCounterArrayW = pdh.func('uint32 __stdcall PdhGetFormattedCounterArrayW(void *counter, uint32 fmt, _Inout_ uint32 *bufSize, _Out_ uint32 *count, _Out_ uint8_t *buf)')
const PdhCloseQuery = pdh.func('uint32 __stdcall PdhCloseQuery(void *query)')

const ft = (f) => BigInt(f.hi) * 4294967296n + BigInt(f.lo)
const PQLI = 0x1000
const PTERMINATE = 0x1
const TOKEN_QUERY = 0x8
const TH32CS_SNAPPROCESS = 0x2
const PDH_FMT_DOUBLE = 0x200
const PDH_MORE_DATA = 0x800007d2
const hex = (n) => '0x' + (n >>> 0).toString(16)
const out = {}

function readCpuTimes() {
  const i = {}, k = {}, u = {}
  GetSystemTimes(i, k, u)
  return { idle: ft(i), total: ft(k) + ft(u) } // kernel time already includes idle
}
function readRam() {
  const s = { dwLength: koffi.sizeof(MEMORYSTATUSEX) }
  GlobalMemoryStatusEx(s)
  return { totalBytes: Number(s.ullTotalPhys), usedBytes: Number(s.ullTotalPhys - s.ullAvailPhys), memoryLoad: s.dwMemoryLoad }
}
function readPower() {
  const p = {}
  GetSystemPowerStatus(p)
  return p
}
function lightSample(prev) {
  const c = readCpuTimes()
  const cpu = prev ? Number((100n * (c.total - prev.total - (c.idle - prev.idle))) / (c.total - prev.total || 1n)) : null
  return { c, cpu, ram: readRam(), power: readPower() }
}

function disks() {
  const mask = GetLogicalDrives()
  const res = []
  for (let i = 0; i < 26; i++) {
    if (!(mask & (1 << i))) continue
    const root = String.fromCharCode(65 + i) + ':\\'
    const type = GetDriveTypeW(root)
    if (type !== 3) { res.push({ root, type, skipped: true }); continue }
    const a = [0n], t = [0n], f = [0n]
    if (GetDiskFreeSpaceExW(root, a, t, f)) {
      res.push({ root, type, totalGB: +(Number(t[0]) / 2 ** 30).toFixed(1), freeGB: +(Number(f[0]) / 2 ** 30).toFixed(1) })
    } else res.push({ root, type, error: 'GetDiskFreeSpaceExW returned false' })
  }
  return res
}

function pdhQuery() {
  const q = [null]
  const s = PdhOpenQueryW(null, 0, q)
  if (s !== 0) throw new Error('PdhOpenQueryW ' + hex(s))
  const add = (path) => {
    const c = [null]
    const st = PdhAddEnglishCounterW(q[0], path, 0, c)
    if (st !== 0) throw new Error(path + ' add ' + hex(st))
    return c[0]
  }
  return { q: q[0], add }
}
function pdhValue(counter) {
  const type = [0], v = {}
  const st = PdhGetFormattedCounterValue(counter, PDH_FMT_DOUBLE, type, v)
  if (st !== 0) throw new Error('GetFormatted ' + hex(st))
  return v.doubleValue
}
function pdhArraySum(counter) {
  const size = [0], count = [0]
  let st = PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, size, count, null)
  if (st >>> 0 !== PDH_MORE_DATA) throw new Error('array size query ' + hex(st))
  const buf = Buffer.alloc(size[0])
  st = PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, size, count, buf)
  if (st !== 0) throw new Error('array ' + hex(st))
  const items = koffi.decode(buf, koffi.array(PDH_ITEM, count[0]))
  return { sum: items.reduce((a, i) => a + i.FmtValue.doubleValue, 0), items: items.map((i) => [i.szName, +i.FmtValue.doubleValue.toFixed(1)]) }
}

let selfSid = null // keeps buffer alive
function tokenUser(h) {
  const tok = [null]
  if (!OpenProcessToken(h, TOKEN_QUERY, tok)) return null
  try {
    const need = [0]
    GetTokenInformation(tok[0], 1 /* TokenUser */, null, 0, need)
    const buf = Buffer.alloc(need[0])
    if (!GetTokenInformation(tok[0], 1, buf, buf.length, need)) return null
    return { buf, sid: koffi.decode(buf, 'void *') }
  } finally {
    CloseHandle(tok[0])
  }
}
function listProcesses() {
  const snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
  const procs = []
  try {
    const e = { dwSize: koffi.sizeof(PROCESSENTRY32W) }
    let ok = Process32FirstW(snap, e)
    while (ok) {
      procs.push({ pid: e.th32ProcessID, name: e.szExeFile })
      ok = Process32NextW(snap, e)
    }
  } finally {
    CloseHandle(snap)
  }
  return procs
}
function inspect(pid, st) {
  const h = OpenProcess(PQLI, false, pid)
  if (!h) { st.openDenied++; return null }
  try {
    const cr = {}, ex = {}, kr = {}, us = {}
    const r = { pid }
    if (GetProcessTimes(h, cr, ex, kr, us)) { r.start = ft(cr); r.cpuTime = ft(kr) + ft(us) } else st.timesFail++
    const m = { cb: koffi.sizeof(PMC) }
    if (K32GetProcessMemoryInfo(h, m, m.cb)) r.priv = Number(m.PrivateUsage); else st.memFail++
    const crit = [0]
    r.critical = IsProcessCritical(h, crit) ? crit[0] !== 0 : null
    if (r.critical === null) st.critFail++
    const sess = [0]
    r.session = ProcessIdToSessionId(pid, sess) ? sess[0] : null
    const tu = tokenUser(h)
    if (tu && selfSid) r.mine = Boolean(EqualSid(tu.sid, selfSid.sid)); else { r.mine = null; st.tokenFail++ }
    return r
  } finally {
    CloseHandle(h)
  }
}
function fullProcessSample() {
  const st = { openDenied: 0, timesFail: 0, memFail: 0, critFail: 0, tokenFail: 0 }
  const list = listProcesses()
  const rows = []
  for (const p of list) { const r = inspect(p.pid, st); if (r) rows.push({ ...p, ...r }) }
  return { total: list.length, rows, stats: st }
}

async function main() {
  const o = out
  o.node = process.version
  o.koffi = koffi.version
  o.platform = process.platform + ' ' + process.arch
  const mySession = [0]
  ProcessIdToSessionId(process.pid, mySession)
  o.mySession = mySession[0]
  selfSid = tokenUser(GetCurrentProcess())
  o.selfSidResolved = Boolean(selfSid)

  const a = lightSample(null)
  await sleep(1000)
  const b = lightSample(a.c)
  o.cpuPercent = b.cpu
  o.ram = b.ram
  const p = b.power
  o.power = { ...p, hasBattery: (p.BatteryFlag & 128) === 0 && p.BatteryFlag !== 255 }
  o.disks = disks()

  try {
    const { q, add } = pdhQuery()
    const idle = add('\\PhysicalDisk(_Total)\\% Idle Time')
    const sent = add('\\Network Interface(*)\\Bytes Sent/sec')
    const recv = add('\\Network Interface(*)\\Bytes Received/sec')
    PdhCollectQueryData(q)
    await sleep(1100)
    o.pdhCollectStatus = PdhCollectQueryData(q)
    o.diskActivityPercent = +(100 - Math.min(100, pdhValue(idle))).toFixed(1)
    o.netUp = pdhArraySum(sent)
    o.netDown = pdhArraySum(recv)
    const t = []
    for (let i = 0; i < 20; i++) {
      await sleep(60)
      const s = hr()
      PdhCollectQueryData(q)
      pdhValue(idle); pdhArraySum(sent); pdhArraySum(recv)
      t.push(ms(s, hr()))
    }
    o.costPdhSampleMs = stats(t)
    PdhCloseQuery(q)
  } catch (e) {
    o.pdhError = String(e)
  }

  {
    const t = []
    let prev = a.c
    for (let i = 0; i < 100; i++) {
      const s = hr()
      const r = lightSample(prev)
      prev = r.c
      t.push(ms(s, hr()))
      await sleep(5)
    }
    o.costLightMs = stats(t)
  }

  {
    const t = []
    let last
    for (let i = 0; i < 20; i++) {
      const s = hr()
      last = fullProcessSample()
      t.push(ms(s, hr()))
      await sleep(50)
    }
    o.costProcessListMs = stats(t)
    const rows = last.rows
    o.processes = {
      total: last.total, opened: rows.length, stats: last.stats,
      mine: rows.filter((r) => r.mine).length, notMine: rows.filter((r) => r.mine === false).length,
      critical: rows.filter((r) => r.critical).map((r) => r.name),
      otherSession: rows.filter((r) => r.session !== o.mySession).length,
      top5ByPrivate: [...rows].sort((x, y) => (y.priv || 0) - (x.priv || 0)).slice(0, 5)
        .map((r) => [r.pid, r.name, Math.round((r.priv || 0) / 2 ** 20) + 'MB', r.mine]),
    }
    const s1 = fullProcessSample()
    const w1 = hr()
    await sleep(1000)
    const s2 = fullProcessSample()
    const dt = Number(hr() - w1) / 1e9
    const nCores = os.cpus().length
    const m1 = new Map(s1.rows.map((r) => [r.pid, r]))
    o.cores = nCores
    o.topCpu = s2.rows
      .map((r) => { const q = m1.get(r.pid); return q && q.start === r.start ? [r.name, +((Number(r.cpuTime - q.cpuTime) * 100) / 1e7 / (dt * nCores)).toFixed(1)] : null })
      .filter(Boolean).sort((x, y) => y[1] - x[1]).slice(0, 5)
  }

  {
    const child = spawn('ping', ['-n', '60', '127.0.0.1'], { stdio: 'ignore', windowsHide: true })
    await sleep(300)
    const h = OpenProcess(PQLI | PTERMINATE, false, child.pid)
    const t = { pid: child.pid, opened: Boolean(h) }
    if (h) {
      try {
        const cr = {}, ex = {}, kr = {}, us = {}
        GetProcessTimes(h, cr, ex, kr, us)
        t.startTimeFileTime = String(ft(cr))
        const tu = tokenUser(h)
        t.ownerIsMe = tu ? Boolean(EqualSid(tu.sid, selfSid.sid)) : null
        const crit = [0]
        IsProcessCritical(h, crit)
        t.critical = crit[0] !== 0
        t.terminated = Boolean(TerminateProcess(h, 1))
      } finally {
        CloseHandle(h)
      }
    }
    await sleep(300)
    t.exitedSeen = child.exitCode !== null || child.signalCode !== null
    if (!t.exitedSeen) child.kill()
    o.terminateTest = t
    const again = OpenProcess(PQLI, false, child.pid)
    o.openGonePidFails = !again
    if (again) CloseHandle(again)
  }

  console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v), 2))
}
main().catch((e) => { console.error('PROBE FAILED', e); process.exit(1) })
