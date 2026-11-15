import type { Reminder } from '../../shared/reminders/schema'
import type { Logger } from '../services/logger'
import type { RemindersService } from './reminders-service'

/** Largest delay `setTimeout` accepts; longer ones fire immediately. */
export const MAX_TIMEOUT_MS = 2_147_483_647
export const SAFETY_INTERVAL_MS = 60_000
/** After a failed pass (e.g. the file is locked or the disk is full), wait this long before retrying. */
export const RETRY_MS = 30_000

export interface SchedulerTimers {
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
  setInterval: typeof setInterval
  clearInterval: typeof clearInterval
}

export interface ReminderSchedulerOptions {
  service: Pick<RemindersService, 'markDue' | 'markMissedOnStart' | 'purgeDone' | 'nextDueAt'>
  now: () => Date
  timers: SchedulerTimers
  onFired: (batch: Reminder[]) => void
  onMissed: (missed: Reminder[]) => void
  logger: Logger
  safetyIntervalMs?: number
}

export interface ReminderScheduler {
  start(): Promise<void>
  reschedule(): void
  check(): Promise<void>
  dispose(): void
}

/**
 * One timer aimed at the next due reminder, plus a periodic safety check that catches clock
 * jumps and suspended timers. Logs carry ids and counts only, never reminder text.
 */
export const createReminderScheduler = ({
  service,
  now,
  timers,
  onFired,
  onMissed,
  logger,
  safetyIntervalMs = SAFETY_INTERVAL_MS,
}: ReminderSchedulerOptions): ReminderScheduler => {
  const log = logger.child('reminders')
  let timeout: ReturnType<typeof setTimeout> | null = null
  let interval: ReturnType<typeof setInterval> | null = null
  let started = false
  let disposed = false
  let running: Promise<void> | null = null
  let rerun = false
  /** Epoch ms before which the timer must not fire again, set after a failed pass. */
  let retryNotBefore: number | null = null

  const clearTimer = (): void => {
    if (timeout !== null) {
      timers.clearTimeout(timeout)
      timeout = null
    }
  }

  /** Ms left in the failure backoff; clamped so a backwards clock jump cannot stretch it. */
  const backoffRemaining = (): number =>
    retryNotBefore === null ? 0 : Math.min(Math.max(0, retryNotBefore - now().getTime()), RETRY_MS)

  const reschedule = (): void => {
    clearTimer()
    if (disposed) return
    let dueAt: Date | null
    try {
      dueAt = service.nextDueAt()
    } catch (error) {
      log.error('nextDueAt failed', error)
      return
    }
    if (dueAt === null) return
    const nowMs = now().getTime()
    // While a failure backoff is active, an overdue reminder must not re-arm at 0: that would
    // turn a persistent write failure into a tight loop of writes and error logs.
    const delay = Math.min(Math.max(0, dueAt.getTime() - nowMs, backoffRemaining()), MAX_TIMEOUT_MS)
    timeout = timers.setTimeout(() => {
      timeout = null
      void check()
    }, delay)
  }

  /** One markDue pass, then re-arm. Resolves false when markDue failed. */
  const pass = async (): Promise<boolean> => {
    let ok = true
    if (backoffRemaining() > 0) {
      // A safety tick or an external check during the backoff: wait for the retry timer.
      reschedule()
      return false
    }
    try {
      const batch = await service.markDue()
      retryNotBefore = null
      if (!disposed && batch.length > 0) {
        try {
          onFired(batch)
        } catch (error) {
          log.error('onFired failed', error)
        }
      }
    } catch (error) {
      log.error('markDue failed', error)
      retryNotBefore = now().getTime() + RETRY_MS
      ok = false
    }
    reschedule()
    return ok
  }

  const check = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (running) {
      // Coalesce: whoever arrives mid-run is covered by exactly one more pass.
      rerun = true
      return running
    }
    const run = (async () => {
      try {
        let ok: boolean
        do {
          rerun = false
          ok = await pass()
          // After a failure the backoff timer (or the safety interval) retries; a coalesced
          // request must not trigger an immediate second failing write.
        } while (rerun && ok && !disposed)
      } finally {
        // Cleared synchronously with the loop exit so a check() can never land in a gap
        // where `running` is still set but no further pass will happen.
        running = null
      }
    })()
    running = run
    return run
  }

  const start = async (): Promise<void> => {
    if (started || disposed) return
    started = true
    try {
      await service.purgeDone()
    } catch (error) {
      log.error('purgeDone failed', error)
    }
    try {
      const missed = await service.markMissedOnStart()
      if (!disposed && missed.length > 0) onMissed(missed)
    } catch (error) {
      log.error('markMissedOnStart failed', error)
    }
    if (disposed) return
    reschedule()
    interval = timers.setInterval(() => {
      void check()
    }, safetyIntervalMs)
  }

  const dispose = (): void => {
    disposed = true
    clearTimer()
    if (interval !== null) {
      timers.clearInterval(interval)
      interval = null
    }
  }

  return { start, reschedule, check, dispose }
}
