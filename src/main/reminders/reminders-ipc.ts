import type { ChannelName } from '../../shared/ipc/channels'
import type { IpcEventLike, IpcHandlers } from '../ipc/register'
import type { RemindersService } from './reminders-service'
import type { RemindersSnapshot } from './reminders-runtime'

type RemindersChannel = Extract<ChannelName, `reminders:${string}`>
type Guard = (event: IpcEventLike) => boolean

/**
 * Every handler waits for the runtime to finish starting, so a renderer that asks early gets the
 * loaded list (never an empty one) and mutations never run against an unloaded store.
 */
export const createRemindersIpcHandlers = (
  service: Pick<RemindersService, 'create' | 'update' | 'snooze' | 'complete' | 'remove'>,
  snapshot: () => RemindersSnapshot,
  ready: () => Promise<void> = () => Promise.resolve(),
): Pick<IpcHandlers, RemindersChannel> => ({
  'reminders:list': async () => {
    await ready()
    return snapshot()
  },
  'reminders:create': async (input) => {
    await ready()
    return service.create(input)
  },
  'reminders:update': async (input) => {
    await ready()
    return service.update(input)
  },
  'reminders:snooze': async ({ id }) => {
    await ready()
    return service.snooze(id)
  },
  'reminders:complete': async ({ id }) => {
    await ready()
    return service.complete(id)
  },
  'reminders:delete': async ({ id }) => {
    await ready()
    await service.remove(id)
    return null
  },
})

/** Editing belongs to the Control Center's form; everything else works from the notch too. */
export const remindersChannelGuards = ({
  fromNotch,
  fromControlCenter,
}: {
  fromNotch: Guard
  fromControlCenter: Guard
}): Record<RemindersChannel, Guard> => {
  const either: Guard = (event) => fromNotch(event) || fromControlCenter(event)
  return {
    'reminders:list': either,
    'reminders:create': either,
    'reminders:update': fromControlCenter,
    'reminders:snooze': either,
    'reminders:complete': either,
    'reminders:delete': either,
  }
}
