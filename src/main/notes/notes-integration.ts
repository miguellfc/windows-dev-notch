import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { emitEvent, type EventTarget } from '../ipc/events'
import type { Logger } from '../services/logger'
import { createNotesIpcHandlers, type NotesSnapshot } from './notes-ipc'
import { createNotesService } from './notes-service'
import { createNotesStore } from './notes-store'

export interface NotesIntegrationOptions {
  userDataDir: string
  logger: Logger
  now: () => Date
  /** The notch window, when it exists: the only receiver of `notes:changed`. */
  notchTarget: () => EventTarget | null
  /** Electron's `clipboard.writeText`. */
  writeClipboard: (text: string) => void
}

/** Electron adapter for notes: real file, service, and `notes:changed` to the notch only. */
export function createNotesIntegration(options: NotesIntegrationOptions) {
  const { logger } = options
  const store = createNotesStore({ file: join(options.userDataDir, 'notes.json'), logger, now: options.now })
  let notice: NotesSnapshot['notice'] = null
  let markReady: () => void = () => undefined
  const ready = new Promise<void>((resolve) => {
    markReady = resolve
  })

  const snapshot = (): NotesSnapshot => ({ notes: service.list(), notice })

  const service = createNotesService({
    store,
    now: options.now,
    newId: () => randomUUID(),
    onChange: () => {
      const target = options.notchTarget()
      if (target) emitEvent([target], 'notes:changed', snapshot(), logger)
    },
    // Name only: the snapshot that failed to go out carries note text.
    onListenerError: (error: unknown) =>
      logger.warn('Notes change listener failed', { error: error instanceof Error ? error.name : typeof error }),
  })

  return {
    handlers: createNotesIpcHandlers(service, snapshot, options.writeClipboard, () => ready),
    /** Loads the file; IPC calls wait for this to finish (even if it failed). */
    async start(): Promise<void> {
      try {
        const loaded = await store.load()
        notice = loaded === 'ok' ? null : loaded
        const target = options.notchTarget()
        if (target) emitEvent([target], 'notes:changed', snapshot(), logger)
      } finally {
        markReady()
      }
    },
    /** Waits for any in-flight write (create, edit, delete...) so quitting never cuts a save short. */
    flush: (): Promise<void> => service.idle(),
  }
}
