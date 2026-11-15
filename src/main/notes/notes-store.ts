import { rename } from 'node:fs/promises'
import { join, parse } from 'node:path'
import { notesFileSchema, type Note } from '../../shared/notes/schema'
import { ExposedIpcError } from '../ipc/errors'
import { readTextFile, writeFileAtomic } from '../services/fs-atomic'
import type { Logger } from '../services/logger'

export type NotesLoadResult = 'ok' | 'quarantined' | 'read-only'

export interface NotesStoreOptions {
  file: string
  logger: Logger
  now: () => Date
}

export interface NotesStore {
  load(): Promise<NotesLoadResult>
  all(): readonly Note[]
  write(next: readonly Note[]): Promise<void>
}

const CURRENT_VERSION = 1

/** Name and code of a thrown value, without its message or stack. */
const errorSummary = (error: unknown): { name: string; code?: string } => {
  const name = error instanceof Error ? error.name : typeof error
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? { name, code } : { name }
}

const isNewerVersion = (raw: unknown): boolean =>
  typeof raw === 'object' &&
  raw !== null &&
  typeof (raw as { version?: unknown }).version === 'number' &&
  (raw as { version: number }).version > CURRENT_VERSION

/**
 * Owns `notes.json`: validates on read and write, writes atomically, serializes writes,
 * quarantines unreadable files and refuses to overwrite files from a newer app version.
 * Never logs note text.
 */
export const createNotesStore = ({ file, logger, now }: NotesStoreOptions): NotesStore => {
  const log = logger.child('notes-store')
  let current: readonly Note[] = []
  let readOnly = false
  let queue: Promise<unknown> = Promise.resolve()

  const quarantine = async (reason: string): Promise<NotesLoadResult> => {
    const { dir, name } = parse(file)
    const stamp = now().toISOString().replace(/[:.]/g, '-')
    const target = join(dir, `${name}.corrupt-${stamp}.json`)
    await rename(file, target)
    log.warn(`${reason}; moved it aside and started with an empty list`, { quarantine: target })
    current = []
    return 'quarantined'
  }

  const loadFromDisk = async (): Promise<NotesLoadResult> => {
    const text = await readTextFile(file)
    if (text === null) return 'ok'

    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return quarantine('Notes file is not valid JSON')
    }

    if (isNewerVersion(raw)) {
      log.warn('Notes file comes from a newer version; read-only mode', {
        version: (raw as { version: number }).version,
      })
      readOnly = true
      return 'read-only'
    }

    const parsed = notesFileSchema.safeParse(raw)
    if (!parsed.success) return quarantine('Notes file does not match the schema')

    current = parsed.data.notes
    log.info('Notes loaded', { count: current.length })
    return 'ok'
  }

  return {
    /** Never rejects: an unreadable or immovable file leaves the store read-only and empty. */
    async load() {
      try {
        return await loadFromDisk()
      } catch (error) {
        // Name and code only: an error message could quote part of the file.
        log.error('Could not load notes; read-only mode', { error: errorSummary(error) })
        readOnly = true
        current = []
        return 'read-only'
      }
    },

    all: () => current,

    write(next) {
      const run = queue.then(async () => {
        if (readOnly) throw new ExposedIpcError('READ_ONLY', 'Notes are read-only in this session; changes cannot be saved')
        const data = notesFileSchema.parse({ version: CURRENT_VERSION, notes: next })
        await writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`)
        current = data.notes
        log.debug('Notes saved', { count: current.length })
      })
      queue = run.catch(() => undefined)
      return run
    },
  }
}
