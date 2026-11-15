import { create } from 'zustand'
import type { Note } from '../../shared/notes/schema'

export type NotesNotice = 'quarantined' | 'read-only' | null

interface NotesStoreState {
  /** Null until the first snapshot arrives. Pinned first, then most recently edited. */
  notes: Note[] | null
  notice: NotesNotice
}

export const useNotes = create<NotesStoreState>(() => ({ notes: null, notice: null }))

/** Keeps the store in sync with the main process; subscribe first so an early read never wins. */
export function bindNotes(): void {
  let pushed = false
  window.notch.events.on('notes:changed', ({ notes, notice }) => {
    pushed = true
    useNotes.setState({ notes, notice })
  })
  void window.notch.notes.list().then((result) => {
    if (result.ok && !pushed) useNotes.setState({ notes: result.data.notes, notice: result.data.notice })
  })
}
