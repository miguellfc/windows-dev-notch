import { localDate } from '../../shared/code-review/contributions'
import type { RedmineAlert } from '../../shared/redmine/schema'
import type { RedmineSettings } from '../../shared/settings/schema'

/** Largest delay `setTimeout` accepts; longer ones fire immediately. */
const MAX_TIMEOUT_MS = 2_147_483_647
export const END_OF_DAY_SAFETY_INTERVAL_MS = 60_000
/** A check that finds the time long past (a PC that slept through it) no longer alerts. */
export const END_OF_DAY_GRACE_MS = 3_600_000

export interface EndOfDayTimers {
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
  setInterval: typeof setInterval
  clearInterval: typeof clearInterval
}

export interface EndOfDaySettingsSource {
  get(): { readonly redmine: RedmineSettings }
  onChange(listener: (settings: { readonly redmine: RedmineSettings }) => void): () => void
}

export interface EndOfDaySchedulerOptions {
  settings: EndOfDaySettingsSource
  /** Wall clock; the dev-only test clock shifts it. */
  now: () => Date
  timers: EndOfDayTimers
  /** Hours logged today, or null before the first reading. */
  todayHours: () => number | null
  /** Whether there is a usable Redmine session (a configured key the server has not rejected). */
  isConnected: () => boolean
  /**
   * Shows the alert; false when it could not be shown (a panel is open): the day then stays open and
   * the next check offers it again, within the grace window.
   */
  onAlert: (alert: RedmineAlert) => boolean
}

export interface EndOfDayScheduler {
  start(): void
  check(): void
  dispose(): void
}

/** Monday to Friday. */
const isWeekday = (date: Date): boolean => date.getDay() >= 1 && date.getDay() <= 5

/** `day` at the local `HH:mm` of the settings (seconds and milliseconds zero). */
const dueOn = (day: Date, time: string): Date => {
  const [hours = 0, minutes = 0] = time.split(':').map(Number)
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, 0, 0)
}

/**
 * The end-of-day alert: on weekdays at `endOfDay.time` (local), once a day, when there is a session
 * and today's hours are under the daily target. One timer aims at the next due moment; a 60 s safety
 * interval and `check()` (power resume, unlock) catch suspended timers and a first reading of the
 * hours that arrives after the time. An alert refused with a panel open is offered again on the next
 * check while within the grace window. A start after the time, or a settings change that moves the time
 * to one already past, does not alert that day. Memory only: nothing is stored.
 */
export function createEndOfDayScheduler(options: EndOfDaySchedulerOptions): EndOfDayScheduler {
  const { settings, now, timers, onAlert } = options
  let timeout: ReturnType<typeof setTimeout> | null = null
  let interval: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | null = null
  let started = false
  let disposed = false
  /** The day (local `YYYY-MM-DD`) already decided: alerted, or nothing to alert about. */
  let settledDay: string | null = null
  /** A due moment before this (app start, a settings change) was missed, not due. */
  let notBefore = 0
  let lastSettings = settings.get().redmine.endOfDay

  const clearTimer = (): void => {
    if (timeout !== null) timers.clearTimeout(timeout)
    timeout = null
  }

  /** Arms the timer for the next due moment still ahead; today's pending one is left to the safety interval. */
  const reschedule = (): void => {
    clearTimer()
    const { enabled, time } = settings.get().redmine.endOfDay
    if (disposed || !enabled) return
    const current = now()
    for (let offset = 0; offset <= 7; offset++) {
      const day = new Date(current.getFullYear(), current.getMonth(), current.getDate() + offset)
      if (!isWeekday(day) || localDate(day) === settledDay) continue
      const due = dueOn(day, time)
      if (due.getTime() < notBefore || due.getTime() <= current.getTime()) continue
      timeout = timers.setTimeout(() => {
        // Only the timer's own firing forgets its handle: any other check() re-arms through clearTimer().
        timeout = null
        check()
      }, Math.min(due.getTime() - current.getTime(), MAX_TIMEOUT_MS))
      return
    }
  }

  function check(): void {
    if (disposed || !started) return
    const { redmine } = settings.get()
    const current = now()
    const day = localDate(current)
    if (redmine.endOfDay.enabled && isWeekday(current) && settledDay !== day) {
      const due = dueOn(current, redmine.endOfDay.time).getTime()
      const late = current.getTime() - due
      if (due >= notBefore && late >= 0) {
        if (late > END_OF_DAY_GRACE_MS) {
          settledDay = day
        } else if (options.isConnected()) {
          // Without a reading yet the day stays open: the next tick looks again.
          const hours = options.todayHours()
          if (hours !== null && (hours >= redmine.dailyTargetHours || onAlert({ hours, target: redmine.dailyTargetHours }))) {
            settledDay = day
          }
        }
      }
    }
    reschedule()
  }

  return {
    start() {
      if (started || disposed) return
      started = true
      notBefore = now().getTime()
      unsubscribe = settings.onChange((next) => {
        const endOfDay = next.redmine.endOfDay
        if (endOfDay.time !== lastSettings.time || endOfDay.enabled !== lastSettings.enabled) notBefore = now().getTime()
        lastSettings = endOfDay
        check()
      })
      interval = timers.setInterval(check, END_OF_DAY_SAFETY_INTERVAL_MS)
      check()
    },
    check,
    dispose() {
      disposed = true
      clearTimer()
      if (interval !== null) timers.clearInterval(interval)
      interval = null
      unsubscribe?.()
      unsubscribe = null
    },
  }
}
