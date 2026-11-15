import { ArrowLeft, Plus, Search, TriangleAlert } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useNotes } from '../../shared/notes-store'
import { useT } from '../../shared/use-t'
import { headerIconButton } from '../reminders/styles'
import { NoteEditor } from './NoteEditor'
import { NoteList } from './NoteList'
import { UNDO_MS, UndoBar } from './UndoBar'

/** `focusNoteId`: after editing, focus goes back to that note's Edit button instead of "+". */
type Screen = { kind: 'list'; focusNoteId?: string } | { kind: 'editor'; noteId: string | null }

/** A delete the undo bar can still offer, until `expiresAt` (5 s after it). */
interface Deleted {
  id: string
  expiresAt: number
}

/**
 * Esc anywhere in the list (a row button, a blank area) goes back to the integrations row instead
 * of closing the notch. The search box and the editor handle their own Esc first and stop it.
 * React's stopPropagation also stops the native bubble, so NotchApp's window-level dismiss never sees it.
 */
const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  void window.notch.notch.back()
}

function NotesNotice() {
  const t = useT()
  const notice = useNotes((store) => store.notice)
  if (!notice) return null
  return (
    <p
      role="status"
      data-testid="notes-notice"
      className="flex shrink-0 items-center gap-2 rounded-tile border border-line bg-veil px-2.5 py-1.5 text-small text-graphite"
    >
      <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-wait" />
      <span className="min-w-0">{t(notice === 'quarantined' ? 'notes.notice.quarantined' : 'notes.notice.readOnly')}</span>
    </p>
  )
}

/** The notes mini tool: search and list, "+" or Edit swap the list for the editor. */
export function NotesView() {
  const t = useT()
  const notes = useNotes((store) => store.notes)
  const [screen, setScreen] = useState<Screen>({ kind: 'list' })
  const [query, setQuery] = useState('')
  // Oldest first; the bar offers the newest.
  const [deleted, setDeleted] = useState<readonly Deleted[]>([])
  const addButton = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  // The note being edited went away (deleted elsewhere): close the editor silently. Adjusted during
  // render, so the editor never saves over a note that is gone, and an undo never reopens it.
  const editingGone =
    screen.kind === 'editor' && screen.noteId !== null && notes !== null && !notes.some((n) => n.id === screen.noteId)
  if (editingGone) setScreen({ kind: 'list' })

  // The tile that opened the view unmounts, and so does the editor on its way back: keep focus in
  // the panel (on the edited note's Edit button, else "+") so the keyboard and the panel's Esc keep working.
  useEffect(() => {
    if (screen.kind !== 'list') return
    const edit = screen.focusNoteId
      ? panel.current?.querySelector<HTMLElement>(`[data-note-id="${CSS.escape(screen.focusNoteId)}"] [data-testid="note-edit"]`)
      : null
    ;(edit ?? addButton.current)?.focus()
  }, [screen])

  // Anything else that removes the focused element (the undo bar timing out or restoring) would drop
  // focus to <body>, where Esc closes the notch. Rows restore their own focus first (child effect).
  useLayoutEffect(() => {
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    if (screen.kind === 'list') (addButton.current ?? panel.current)?.focus()
  })

  // The undo bar belongs to the list: opening the editor ends it (main still restores for 10 s, but
  // nothing offers it any more), so it never reappears with a restarted 5 s on the way back.
  const openEditor = (noteId: string | null) => {
    setDeleted([])
    setScreen({ kind: 'editor', noteId })
  }

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape' || query === '') return
    // First Esc clears the search; the next one reaches the panel (back to the row).
    event.preventDefault()
    event.stopPropagation()
    setQuery('')
  }

  const lastDeleted = deleted.at(-1)
  const editing = screen.kind === 'editor' ? (screen.noteId === null ? null : notes?.find((n) => n.id === screen.noteId)) : undefined

  return (
    // Focusable (not tabbable): a click on a blank area keeps focus in the panel, so Esc reaches
    // onPanelKeyDown (back to the row) instead of NotchApp's window-level dismiss.
    <div
      ref={panel}
      role="region"
      aria-label={t('integration.notes')}
      data-testid="notes-panel"
      tabIndex={-1}
      onKeyDown={onPanelKeyDown}
      className="flex h-full flex-col gap-2 px-3 pb-3 pt-2 outline-none"
    >
      {editing !== undefined ? (
        <NoteEditor
          key={editing?.id ?? 'new'}
          note={editing}
          onDone={() => setScreen(editing ? { kind: 'list', focusNoteId: editing.id } : { kind: 'list' })}
        />
      ) : (
        <>
          <header className="flex h-8 shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => void window.notch.notch.back()}
              aria-label={t('notes.view.back')}
              title={t('notes.view.back')}
              className={headerIconButton}
            >
              <ArrowLeft size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
            <button
              ref={addButton}
              type="button"
              data-testid="notes-add"
              onClick={() => openEditor(null)}
              aria-label={t('notes.view.new')}
              title={t('notes.view.new')}
              className={headerIconButton}
            >
              <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
            <h2 className="ml-2 shrink-0 text-body font-medium text-chalk">{t('integration.notes')}</h2>
            <label className="relative ml-auto flex w-[180px] min-w-0 items-center">
              <span className="sr-only">{t('notes.search.label')}</span>
              <Search size={13} strokeWidth={1.8} aria-hidden="true" className="pointer-events-none absolute left-2 text-graphite" />
              <input
                type="search"
                data-testid="notes-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onSearchKeyDown}
                placeholder={t('notes.search.placeholder')}
                spellCheck={false}
                autoComplete="off"
                className="h-7 w-full rounded-control border border-line bg-veil pl-7 pr-2 text-small text-chalk placeholder:text-graphite [&::-webkit-search-cancel-button]:hidden"
              />
            </label>
          </header>
          <NotesNotice />
          <NoteList
            query={query}
            onEdit={openEditor}
            onDeleted={(id) => setDeleted((previous) => [...previous, { id, expiresAt: Date.now() + UNDO_MS }])}
            onFocusLost={() => (addButton.current ?? panel.current)?.focus()}
          />
          {lastDeleted && (
            <UndoBar
              key={lastDeleted.id}
              noteId={lastDeleted.id}
              expiresAt={lastDeleted.expiresAt}
              // Earlier deletes whose 5 s are over drop out; one still in time takes the bar.
              onRestored={(id) => setDeleted((previous) => previous.filter((d) => d.id !== id && d.expiresAt > Date.now()))}
              // Every earlier delete expired before this one.
              onExpired={() => setDeleted([])}
            />
          )}
        </>
      )}
    </div>
  )
}
