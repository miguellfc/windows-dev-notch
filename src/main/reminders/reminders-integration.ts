import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Notification, powerMonitor } from 'electron'
import { translate } from '../../shared/i18n/messages'
import type { Language } from '../../shared/settings/schema'
import { emitEvent, type EventTarget } from '../ipc/events'
import type { Logger } from '../services/logger'
import type { NotchController } from '../windows/notch-controller'
import { createReminderToast, type ReminderToastRequest } from './reminder-toast'
import { createRemindersIpcHandlers } from './reminders-ipc'
import { createRemindersRuntime } from './reminders-runtime'
import { createRemindersStore } from './reminders-store'

export interface RemindersIntegrationOptions {
  userDataDir: string
  logger: Logger
  notch: NotchController
  language: () => Language
  snoozeMinutes: () => number
  /** Wall clock; the dev-only test clock shifts it. */
  now: () => Date
  /** The notch window, when it exists (receives `reminders:fired`). */
  notchTarget: () => EventTarget | null
  /** Windows that receive `reminders:changed` (notch, and the Control Center when open). */
  eventTargets: () => EventTarget[]
}

/** Electron adapter around the reminders runtime: real file, toasts, timers and power events. */
export function createRemindersIntegration(options: RemindersIntegrationOptions) {
  const { logger, notch } = options

  // Electron drops click handlers of notifications that get garbage-collected.
  const liveToasts = new Set<Notification>()
  const notify = (request: ReminderToastRequest) => {
    if (!Notification.isSupported()) return
    const toast = new Notification({ title: request.title, body: request.body, silent: request.silent })
    const forget = () => liveToasts.delete(toast)
    toast.on('click', () => {
      forget()
      request.onClick()
    })
    toast.on('close', forget)
    toast.on('failed', forget)
    liveToasts.add(toast)
    toast.show()
  }

  const runtime = createRemindersRuntime({
    store: createRemindersStore({ file: join(options.userDataDir, 'reminders.json'), logger, now: options.now }),
    now: options.now,
    newId: () => randomUUID(),
    snoozeMinutes: options.snoozeMinutes,
    timers: { setTimeout, clearTimeout, setInterval, clearInterval },
    logger,
    toast: createReminderToast({
      notify,
      translate: (key, params) => translate(options.language(), key, params),
      onClick: () => notch.dispatch({ type: 'open-integration', id: 'reminders' }),
    }),
    setDue: (due) => notch.dispatch({ type: 'reminders', due }),
    emitChanged: (snapshot) => emitEvent(options.eventTargets(), 'reminders:changed', snapshot, logger),
    emitFired: (count) => {
      // At startup the notch may not be loaded yet: then the chime is simply skipped.
      const target = options.notchTarget()
      if (target) emitEvent([target], 'reminders:fired', { count }, logger)
    },
  })

  // Timers stall while the PC sleeps; check as soon as it is back.
  const check = () => void runtime.check()
  powerMonitor.on('resume', check)
  powerMonitor.on('unlock-screen', check)

  return {
    handlers: createRemindersIpcHandlers(runtime.service, runtime.snapshot, runtime.ready),
    start: () => runtime.start(),
    check: () => runtime.check(),
    dispose: () => {
      powerMonitor.off('resume', check)
      powerMonitor.off('unlock-screen', check)
      runtime.dispose()
    },
  }
}
