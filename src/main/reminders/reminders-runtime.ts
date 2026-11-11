import type { EventPayload } from '../../shared/ipc/contract'
import type { Reminder } from '../../shared/reminders/schema'
import type { Logger } from '../services/logger'
import { createReminderScheduler, type SchedulerTimers } from './reminder-scheduler'
import type { ReminderToast } from './reminder-toast'
import { createRemindersService, type RemindersService } from './reminders-service'
import type { RemindersStore } from './reminders-store'

export type RemindersSnapshot = EventPayload<'reminders:changed'>
type Notice = RemindersSnapshot['notice']

export interface RemindersRuntimeOptions {
  store: Pick<RemindersStore, 'load' | 'all' | 'write'>
  now: () => Date
  newId: () => string
  /** Read on every snooze so a settings change applies at once. */
  snoozeMinutes: () => number
  timers: SchedulerTimers
  logger: Logger
  toast: Pick<ReminderToast, 'fired' | 'missed'>
  /** Turns the notch's reminder alert on or off. */
  setDue: (due: boolean) => void
  /** `reminders:changed` to the notch and the Control Center. */
  emitChanged: (snapshot: RemindersSnapshot) => void
  /** `reminders:fired` to the notch only (plays the chime). */
  emitFired: (count: number) => void
}

export interface RemindersRuntime {
  service: RemindersService
  snapshot(): RemindersSnapshot
  /** Loads the file, purges old done ones, reports missed ones and arms the timer. */
  start(): Promise<void>
  /** Resolves once `start()` has finished (even if it failed), so IPC never sees an unloaded store. */
  ready(): Promise<void>
  check(): Promise<void>
  dispose(): void
}

/**
 * Electron-free core of the reminders integration: store + service + scheduler, and what happens
 * after each change (alert flag, `reminders:changed`, timer moved to the new next due reminder).
 */
export function createRemindersRuntime(options: RemindersRuntimeOptions): RemindersRuntime {
  const { store, now, logger } = options
  const log = logger.child('reminders')
  let notice: Notice = null
  let markReady: () => void = () => undefined
  const readyPromise = new Promise<void>((resolve) => {
    markReady = resolve
  })

  const snapshot = (): RemindersSnapshot => ({ reminders: service.list(), notice })

  /** After every change: alert flag, renderers, and the timer (creating or snoozing moves it). */
  const publish = () => {
    try {
      options.setDue(service.attentionCount() > 0)
      options.emitChanged(snapshot())
      // Safe: the service only calls back on a mutation, after `scheduler` exists.
      scheduler.reschedule()
    } catch (error) {
      // The change is already on disk: a failed notification must not report it as failed.
      // Only the error type is logged; the payload could carry reminder text.
      log.error('Publishing reminders failed', { error: error instanceof Error ? error.name : typeof error })
    }
  }

  const service = createRemindersService({
    store,
    now,
    newId: options.newId,
    snoozeMinutes: options.snoozeMinutes,
    onChange: publish,
  })

  const fired = (count: number) => {
    log.info('Reminders fired', { count })
    options.emitFired(count)
  }

  const scheduler = createReminderScheduler({
    service,
    now,
    timers: options.timers,
    onFired: (batch: Reminder[]) => {
      options.toast.fired(batch)
      fired(batch.length)
    },
    onMissed: (missed: Reminder[]) => {
      options.toast.missed(missed.length)
      fired(missed.length)
    },
    logger,
  })

  return {
    service,
    snapshot,
    async start() {
      try {
        const loaded = await store.load()
        notice = loaded === 'ok' ? null : loaded
        await scheduler.start()
        // The file may already hold due reminders from the last session: publish even if nothing changed.
        publish()
      } finally {
        markReady()
      }
    },
    ready: () => readyPromise,
    check: () => scheduler.check(),
    dispose: () => scheduler.dispose(),
  }
}
