import { rename } from 'node:fs/promises'
import { join, parse } from 'node:path'
import { remindersFileSchema, type Reminder } from '../../shared/reminders/schema'
import { ExposedIpcError } from '../ipc/errors'
import { readTextFile, writeFileAtomic } from '../services/fs-atomic'
import type { Logger } from '../services/logger'

export type RemindersLoadResult = 'ok' | 'quarantined' | 'read-only'

export interface RemindersStoreOptions {
  file: string
  logger: Logger
  now: () => Date
}

export interface RemindersStore {
  load(): Promise<RemindersLoadResult>
  all(): readonly Reminder[]
  write(next: readonly Reminder[]): Promise<void>
}

const CURRENT_VERSION = 1

const isNewerVersion = (raw: unknown): boolean =>
  typeof raw === 'object' &&
  raw !== null &&
  typeof (raw as { version?: unknown }).version === 'number' &&
  (raw as { version: number }).version > CURRENT_VERSION

/**
 * Owns `reminders.json`: validates on read and write, writes atomically, serializes writes,
 * quarantines unreadable files and refuses to overwrite files from a newer app version.
 */
export const createRemindersStore = ({ file, logger, now }: RemindersStoreOptions): RemindersStore => {
  const log = logger.child('reminders-store')
  let current: readonly Reminder[] = []
  let readOnly = false
  let queue: Promise<unknown> = Promise.resolve()

  const quarantine = async (reason: string): Promise<RemindersLoadResult> => {
    const { dir, name } = parse(file)
    const stamp = now().toISOString().replace(/[:.]/g, '-')
    const target = join(dir, `${name}.corrupt-${stamp}.json`)
    await rename(file, target)
    log.warn(`${reason}; moved it aside and started with an empty list`, { quarantine: target })
    current = []
    return 'quarantined'
  }

  const loadFromDisk = async (): Promise<RemindersLoadResult> => {
    const text = await readTextFile(file)
    if (text === null) return 'ok'

    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return quarantine('Reminders file is not valid JSON')
    }

    if (isNewerVersion(raw)) {
      log.warn('Reminders file comes from a newer version; read-only mode', {
        version: (raw as { version: number }).version,
      })
      readOnly = true
      return 'read-only'
    }

    const parsed = remindersFileSchema.safeParse(raw)
    if (!parsed.success) return quarantine('Reminders file does not match the schema')

    current = parsed.data.reminders
    log.info('Reminders loaded', { count: current.length })
    return 'ok'
  }

  return {
    /** Never rejects: an unreadable or immovable file leaves the store read-only and empty. */
    async load() {
      try {
        return await loadFromDisk()
      } catch (error) {
        log.error('Could not load reminders; read-only mode', { error })
        readOnly = true
        current = []
        return 'read-only'
      }
    },

    all: () => current,

    write(next) {
      const run = queue.then(async () => {
        if (readOnly) throw new ExposedIpcError('READ_ONLY', 'Reminders are read-only in this session; changes cannot be saved')
        const data = remindersFileSchema.parse({ version: CURRENT_VERSION, reminders: next })
        await writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`)
        current = data.reminders
        log.debug('Reminders saved', { count: current.length })
      })
      queue = run.catch(() => undefined)
      return run
    },
  }
}
