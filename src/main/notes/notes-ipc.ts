import type { ChannelName } from '../../shared/ipc/channels'
import type { EventPayload } from '../../shared/ipc/contract'
import type { IpcEventLike, IpcHandlers } from '../ipc/register'
import type { NotesService } from './notes-service'

type NotesChannel = Extract<ChannelName, `notes:${string}`>
type Guard = (event: IpcEventLike) => boolean

export type NotesSnapshot = EventPayload<'notes:changed'>

/**
 * Every handler waits for the integration to finish loading, so a renderer that asks early gets
 * the loaded list (never an empty one) and mutations never run against an unloaded store.
 * Copying goes through main: the renderer names a note by id and never sends clipboard text.
 */
export const createNotesIpcHandlers = (
  service: Pick<NotesService, 'create' | 'update' | 'setPinned' | 'remove' | 'restore' | 'text'>,
  snapshot: () => NotesSnapshot,
  writeClipboard: (text: string) => void,
  ready: () => Promise<void> = () => Promise.resolve(),
): Pick<IpcHandlers, NotesChannel> => ({
  'notes:list': async () => {
    await ready()
    return snapshot()
  },
  'notes:create': async ({ text }) => {
    await ready()
    return service.create(text)
  },
  'notes:update': async ({ id, text }) => {
    await ready()
    return service.update(id, text)
  },
  'notes:pin': async ({ id, pinned }) => {
    await ready()
    return service.setPinned(id, pinned)
  },
  'notes:delete': async ({ id }) => {
    await ready()
    return service.remove(id)
  },
  'notes:restore': async ({ id }) => {
    await ready()
    return service.restore(id)
  },
  'notes:copy': async ({ id }) => {
    await ready()
    writeClipboard(service.text(id))
    return null
  },
})

/** Notes live in the notch only: the Control Center and any other sender are refused. */
export const notesChannelGuards = ({ fromNotch }: { fromNotch: Guard }): Record<NotesChannel, Guard> => ({
  'notes:list': fromNotch,
  'notes:create': fromNotch,
  'notes:update': fromNotch,
  'notes:pin': fromNotch,
  'notes:delete': fromNotch,
  'notes:restore': fromNotch,
  'notes:copy': fromNotch,
})
