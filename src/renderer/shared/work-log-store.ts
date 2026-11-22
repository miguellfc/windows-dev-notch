import { create } from 'zustand'
import type { WorkLogEntryView, WorkLogSnapshot } from '../../shared/work-log/schema'

/** Default idle pause (`workLog.idlePauseMinutes` = 30) until the first snapshot arrives. */
const DEFAULT_IDLE_PAUSE_MS = 30 * 60_000

/** The work log as main last sent it: empty until the first snapshot. */
export const useWorkLogStore = create<WorkLogSnapshot>(() => ({ entries: [], idlePauseMs: DEFAULT_IDLE_PAUSE_MS }))

/** The open view's own height (px, border excluded) for the capsule to fit; null while it is closed. */
export const useWorkLogView = create<{ viewHeight: number | null }>(() => ({ viewHeight: null }))

export function setWorkLogViewHeight(viewHeight: number | null): void {
  if (useWorkLogView.getState().viewHeight !== viewHeight) useWorkLogView.setState({ viewHeight })
}

/** Every entry (running and paused first) and the idle pause in force. */
export function useWorkLog(): WorkLogSnapshot {
  return useWorkLogStore()
}

/**
 * The total as of `now` (main's `Session::live_total_ms`): the time since the last event counts,
 * with idle time over `idlePauseMs` left out unless a turn is open. An ended entry keeps its total.
 */
export function liveTotalMs(entry: WorkLogEntryView, now: number, idlePauseMs: number): number {
  if (entry.live === null) return entry.totalMs
  const since = Math.max(0, now - entry.live.lastEventAt)
  const idle = entry.live.turnOpen ? 0 : Math.max(0, since - idlePauseMs)
  return entry.totalMs + since - idle
}

/** Keeps the store in sync with the main process; subscribe first so an early read never wins. */
export function bindWorkLog(): void {
  let pushed = false
  window.notch.events.on('work-log:changed', (snapshot) => {
    pushed = true
    useWorkLogStore.setState(snapshot, true)
  })
  void window.notch.workLog.list().then((result) => {
    if (result.ok && !pushed) useWorkLogStore.setState(result.data, true)
  })
}
