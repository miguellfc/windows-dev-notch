import { NOTE_LIMIT_MESSAGE, NOTES_MAX, noteSchema, noteTextSchema, type Note } from '../../shared/notes/schema'
import { sortNotes } from '../../shared/notes/search'
import { ExposedIpcError } from '../ipc/errors'
import type { NotesStore } from './notes-store'

export interface NotesServiceOptions {
  store: Pick<NotesStore, 'all' | 'write'>
  now: () => Date
  newId: () => string
  /** Told after every saved mutation; a throw here never fails the mutation. */
  onChange: () => void
  /** Told when `onChange` throws (e.g. to log it). */
  onListenerError?: (error: unknown) => void
}

export interface NotesService {
  list(): Note[]
  create(text: string): Promise<Note>
  update(id: string, text: string): Promise<Note>
  setPinned(id: string, pinned: boolean): Promise<Note>
  /** Removes a note and keeps it restorable for 10 s; resolves with a copy of the removed note. */
  remove(id: string): Promise<Note>
  restore(id: string): Promise<Note>
  /** Current text of a note (for the clipboard); throws NOT_FOUND. */
  text(id: string): string
  /** Settles once every mutation queued so far has finished (saved or failed); never rejects. */
  idle(): Promise<void>
}

/** How long a deleted note stays restorable. */
export const RESTORE_WINDOW_MS = 10_000

const invalid = (message: string): ExposedIpcError => new ExposedIpcError('INVALID_INPUT', message)
const notFound = (): ExposedIpcError => new ExposedIpcError('NOT_FOUND', 'Note not found')

const parseText = (text: string): string => {
  const parsed = noteTextSchema.safeParse(text)
  if (!parsed.success) throw invalid('Invalid note text')
  return parsed.data
}

type Plan = { next: Note[]; changed: string[]; result?: Note }

export const createNotesService = ({
  store,
  now,
  newId,
  onChange,
  onListenerError,
}: NotesServiceOptions): NotesService => {
  let chain: Promise<unknown> = Promise.resolve()
  const deleted = new Map<string, { note: Note; deletedAt: number }>()

  const prune = (): void => {
    const cutoff = now().getTime() - RESTORE_WINDOW_MS
    for (const [id, entry] of deleted) if (entry.deletedAt < cutoff) deleted.delete(id)
  }

  /**
   * Runs one mutation as an exclusive unit (snapshot, compute, validate, write), so concurrent
   * operations never build on a stale snapshot. Every touched note passes through `noteSchema`.
   * `afterWrite` runs only once the write succeeded.
   */
  const mutate = (plan: (all: readonly Note[]) => Plan, afterWrite?: () => void): Promise<Note> => {
    const run = chain.then(async () => {
      prune()
      const planned = plan(store.all())
      const touched = new Set(planned.changed)
      const next = planned.next.map((n) => {
        if (!touched.has(n.id)) return n
        const parsed = noteSchema.safeParse(n)
        if (!parsed.success) throw invalid('Invalid note')
        return parsed.data
      })
      await store.write(next)
      afterWrite?.()
      // The note is saved: a failing listener must not turn that into a rejection.
      try {
        onChange()
      } catch (error) {
        onListenerError?.(error)
      }
      return planned.result ?? next.find((n) => touched.has(n.id))!
    })
    chain = run.catch(() => undefined)
    return run
  }

  const findIn = (all: readonly Note[], id: string): Note => {
    const found = all.find((n) => n.id === id)
    if (!found) throw notFound()
    return found
  }

  const replace = (all: readonly Note[], updated: Note): Plan => ({
    next: all.map((n) => (n.id === updated.id ? updated : n)),
    changed: [updated.id],
  })

  return {
    list: () => sortNotes(store.all()),

    async create(text) {
      const clean = parseText(text)
      return mutate((all) => {
        if (all.length >= NOTES_MAX) throw invalid(NOTE_LIMIT_MESSAGE)
        const at = now().toISOString()
        const fresh: Note = { id: newId(), text: clean, pinned: false, createdAt: at, updatedAt: at }
        return { next: [...all, fresh], changed: [fresh.id] }
      })
    },

    async update(id, text) {
      const clean = parseText(text)
      return mutate((all) => {
        const current = findIn(all, id)
        return replace(all, { ...current, text: clean, updatedAt: now().toISOString() })
      })
    },

    setPinned(id, pinned) {
      return mutate((all) => replace(all, { ...findIn(all, id), pinned }))
    },

    remove(id) {
      let removed: Note | undefined
      return mutate(
        (all) => {
          const current = findIn(all, id)
          removed = { ...current }
          return { next: all.filter((n) => n.id !== id), changed: [], result: { ...current } }
        },
        () => {
          deleted.set(id, { note: removed!, deletedAt: now().getTime() })
        },
      )
    },

    restore(id) {
      return mutate(
        (all) => {
          const entry = deleted.get(id)
          if (!entry || now().getTime() - entry.deletedAt > RESTORE_WINDOW_MS) throw notFound()
          if (all.some((n) => n.id === id)) throw notFound()
          if (all.length >= NOTES_MAX) throw invalid(NOTE_LIMIT_MESSAGE)
          return { next: [...all, { ...entry.note }], changed: [id] }
        },
        () => {
          deleted.delete(id)
        },
      )
    },

    text: (id) => findIn(store.all(), id).text,

    idle: () => chain.then(() => undefined),
  }
}
