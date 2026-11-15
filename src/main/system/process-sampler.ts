import { PROCESS_LIMIT, type KillResult, type ProcessOrder, type ProcessRow } from '../../shared/system/schema'
import type { ProcessEntry, ProcessInfo, SystemApi } from './win32-system'

export interface ProcessSampler {
  /** Top processes by CPU or RAM; remembers the returned rows as "the last list" for `kill`. */
  top(by: ProcessOrder, limit?: number): ProcessRow[]
  /** Closes a process only if it was in the last list with the same start time and is still killable. */
  kill(input: { pid: number; startTime: string }): KillResult
  /** Forgets CPU baselines and the last list. */
  reset(): void
  /** Forgets only the last list (a fresh view must not close rows it never showed); keeps CPU baselines. */
  forgetList(): void
}

interface CpuMark {
  cpuMs: number
  at: number
  /** Last CPU % computed for this process (null until a second sighting). */
  percent: number | null
}

interface Listed {
  startTime: string
  killable: boolean
  /** When the row was last in a returned list. */
  listedAt: number
}

/**
 * A row that just dropped out of the list stays closable this long: the user may have confirmed
 * it right before a CPU re-rank pushed it out. The kill still re-checks everything fresh.
 */
export const LIST_GRACE_MS = 5000
/** Below this interval a delta is too noisy (e.g. a sort switch right after a tick): reuse the last value. */
const MIN_CPU_INTERVAL_MS = 500
const MAX_NAME = 260
/** System Idle Process and System: never closable, whatever the API reports. */
const SYSTEM_PIDS = new Set([0, 4])

function attempt<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

/**
 * All transitive descendants of `root` in the snapshot; a visited set guards against PID-reuse cycles.
 * Limitation: a grandchild whose intermediate parent already exited is orphaned and is not detected.
 */
function descendantsOf(root: number, entries: ProcessEntry[]): Set<number> {
  const children = new Map<number, number[]>()
  for (const e of entries) {
    if (e.pid === e.parentPid) continue
    const list = children.get(e.parentPid)
    if (list) list.push(e.pid)
    else children.set(e.parentPid, [e.pid])
  }
  const visited = new Set<number>([root])
  const stack = [root]
  while (stack.length > 0) {
    const pid = stack.pop() as number
    for (const child of children.get(pid) ?? []) {
      if (visited.has(child)) continue
      visited.add(child)
      stack.push(child)
    }
  }
  visited.delete(root)
  return visited
}

function compareNullableDesc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return b - a
}

/** Pure sampler over `SystemApi`: builds the process list and validates every close request. */
export function createProcessSampler(api: SystemApi, now: () => number): ProcessSampler {
  let marks = new Map<string, CpuMark>()
  let lastList = new Map<number, Listed>()
  /** When the most recent list was built: its rows stay closable until the next list. */
  let lastTopAt: number | null = null

  const isKillable = (pid: number, info: ProcessInfo | null, descendants: Set<number>): boolean =>
    info !== null &&
    info.owner === 'self' &&
    !info.critical &&
    info.sessionId >= 0 &&
    api.selfSessionId >= 0 &&
    info.sessionId === api.selfSessionId &&
    pid !== api.selfPid &&
    !SYSTEM_PIDS.has(pid) &&
    !descendants.has(pid)

  /** Next baseline for a process; a too-short interval keeps the previous baseline and its last value. */
  function nextMark(previous: CpuMark | undefined, cpuMs: number, at: number): CpuMark {
    if (!previous) return { cpuMs, at, percent: null }
    const elapsed = at - previous.at
    if (elapsed < MIN_CPU_INTERVAL_MS) return previous
    if (api.cpuCount <= 0) return { cpuMs, at, percent: null }
    const raw = (100 * (cpuMs - previous.cpuMs)) / (elapsed * api.cpuCount)
    return { cpuMs, at, percent: Math.round(Math.min(100, Math.max(0, raw)) * 10) / 10 }
  }

  function top(by: ProcessOrder, limit = PROCESS_LIMIT): ProcessRow[] {
    const entries = attempt(() => api.processes(), [])
    const descendants = descendantsOf(api.selfPid, entries)
    const at = now()
    lastTopAt = at
    const previous = marks
    marks = new Map()
    const rows: ProcessRow[] = []
    for (const entry of entries) {
      if (!Number.isInteger(entry.pid) || entry.pid <= 0) continue
      const info = attempt(() => api.processInfo(entry.pid), null)
      let cpu: number | null = null
      if (info) {
        const key = `${entry.pid}:${info.startTime}`
        const mark = nextMark(previous.get(key), info.cpuMs, at)
        marks.set(key, mark)
        cpu = mark.percent
      }
      rows.push({
        pid: entry.pid,
        name: entry.name.slice(0, MAX_NAME),
        cpuPercent: cpu,
        privateBytes: info?.privateBytes ?? null,
        startTime: info?.startTime ?? '',
        killable: isKillable(entry.pid, info, descendants),
      })
    }
    rows.sort((a, b) => {
      const primary =
        by === 'cpu'
          ? compareNullableDesc(a.cpuPercent, b.cpuPercent) || compareNullableDesc(a.privateBytes, b.privateBytes)
          : compareNullableDesc(a.privateBytes, b.privateBytes) || compareNullableDesc(a.cpuPercent, b.cpuPercent)
      return primary || a.pid - b.pid
    })
    const result = rows.slice(0, Math.max(0, limit))
    // Updated even if the caller's emit is later refused: kill() then fails closed ('not-killable').
    const next = new Map<number, Listed>(result.map((r) => [r.pid, { startTime: r.startTime, killable: r.killable, listedAt: at }]))
    for (const [pid, listed] of lastList) {
      if (!next.has(pid) && at - listed.listedAt < LIST_GRACE_MS) next.set(pid, listed)
    }
    lastList = next
    return result
  }

  function kill({ pid, startTime }: { pid: number; startTime: string }): KillResult {
    if (!startTime) return 'not-killable'
    const listed = lastList.get(pid)
    if (!listed || listed.startTime !== startTime || !listed.killable) return 'not-killable'
    // A row kept only by the grace period expires with it.
    if (listed.listedAt !== lastTopAt && now() - listed.listedAt >= LIST_GRACE_MS) return 'not-killable'
    const info = attempt(() => api.processInfo(pid), null)
    if (!info || info.startTime !== startTime) return 'gone'
    // Without a fresh snapshot the notch's children cannot be ruled out: refuse rather than guess.
    // The adapter returns [] when the snapshot fails: an empty snapshot proves nothing either.
    const entries = attempt<ProcessEntry[] | null>(() => api.processes(), null)
    if (!entries || entries.length === 0) return 'not-killable'
    const descendants = descendantsOf(api.selfPid, entries)
    if (!isKillable(pid, info, descendants)) return 'not-killable'
    return attempt(() => api.terminate(pid, startTime), 'denied')
  }

  function reset(): void {
    marks = new Map()
    lastList = new Map()
  }

  function forgetList(): void {
    lastList = new Map()
  }

  return { top, kill, reset, forgetList }
}
