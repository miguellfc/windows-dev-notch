import { Check, Copy, Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent } from 'react'
import type { MessageKey } from '../../../shared/i18n/messages'
import type { Result } from '../../../shared/ipc/result'
import type { Note } from '../../../shared/notes/schema'
import { matchesQuery, sortNotes } from '../../../shared/notes/search'
import { useNotes } from '../../shared/notes-store'
import { focusTarget, type FocusMemo } from '../../shared/notes/focus'
import { formatEdited, noteErrorKey, noteLabel } from '../../shared/notes/format'
import { useInFlight } from '../../shared/reminders/use-in-flight'
import { useClock } from '../../shared/use-clock'
import { locale, useLanguage, useT } from '../../shared/use-t'

const COPIED_MS = 1500

type Run = <T>(id: string, call: () => Promise<Result<T>>, onOk?: (data: T) => void) => void

// Busy buttons use aria-disabled, not disabled: a disabled button drops focus to <body>, where Esc
// would dismiss the notch. run() is already a no-op while the note's call is in flight.
const iconButton =
  'flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-control-sm text-graphite transition-colors duration-150 hover:bg-veil-tile hover:text-chalk focus-inset aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-graphite'

interface RowProps {
  note: Note
  now: Date
  run: Run
  busy: boolean
  copied: boolean
  onCopied: (id: string) => void
  onEdit: (id: string) => void
  onDeleted: (id: string) => void
}

/** One note: pin, the first two lines, when it was edited; actions appear on hover or focus. */
function NoteRow({ note, now, run, busy, copied, onCopied, onEdit, onDeleted }: RowProps) {
  const t = useT()
  const language = useLanguage()
  const label = noteLabel(note.text)
  const edited = new Date(note.updatedAt)
  return (
    <li
      data-testid="note-item"
      data-note-id={note.id}
      data-pinned={note.pinned}
      className="group flex shrink-0 flex-col gap-0.5 rounded-tile px-2.5 pb-1 pt-1.5 transition-colors duration-150 hover:bg-veil has-[:focus-visible]:bg-veil"
    >
      <p className="line-clamp-2 whitespace-pre-wrap break-words text-body text-chalk">{note.text}</p>
      <div className="flex h-6 items-center gap-1.5">
        {note.pinned && (
          <Pin size={12} strokeWidth={1.8} role="img" aria-label={t('notes.pinned')} className="shrink-0 text-chalk" />
        )}
        <span className="min-w-0 truncate text-label text-graphite">
          {copied ? (
            <span className="flex items-center gap-1 text-chalk">
              <Check size={12} strokeWidth={2} aria-hidden="true" />
              {t('notes.action.copied')}
            </span>
          ) : (
            <time
              dateTime={note.updatedAt}
              title={new Intl.DateTimeFormat(locale(language), { dateStyle: 'medium', timeStyle: 'short' }).format(edited)}
              className="tabular"
            >
              {formatEdited(edited, now, language)}
            </time>
          )}
        </span>
        <span className="ml-auto flex shrink-0 gap-0.5 opacity-0 transition-opacity duration-150 group-has-[:focus-visible]:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            data-testid="note-copy"
            aria-label={t('notes.action.copyItem', { text: label })}
            title={t('notes.action.copy')}
            className={iconButton}
            aria-disabled={busy}
            onClick={() => run(note.id, () => window.notch.notes.copy({ id: note.id }), () => onCopied(note.id))}
          >
            <Copy size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <button
            type="button"
            data-testid="note-edit"
            aria-label={t('notes.action.editItem', { text: label })}
            title={t('notes.action.edit')}
            className={iconButton}
            aria-disabled={busy}
            onClick={() => {
              if (!busy) onEdit(note.id)
            }}
          >
            <Pencil size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <button
            type="button"
            data-testid="note-pin"
            aria-label={t('notes.action.pinItem', { text: label })}
            title={t('notes.action.pin')}
            aria-pressed={note.pinned}
            className={iconButton}
            aria-disabled={busy}
            onClick={() => run(note.id, () => window.notch.notes.pin({ id: note.id, pinned: !note.pinned }))}
          >
            {note.pinned ? (
              <PinOff size={14} strokeWidth={1.8} aria-hidden="true" />
            ) : (
              <Pin size={14} strokeWidth={1.8} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            data-testid="note-delete"
            aria-label={t('notes.action.deleteItem', { text: label })}
            title={t('notes.action.delete')}
            className={iconButton}
            aria-disabled={busy}
            onClick={() => run(note.id, () => window.notch.notes.delete({ id: note.id }), () => onDeleted(note.id))}
          >
            <Trash2 size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </span>
      </div>
    </li>
  )
}

const ROW = '[data-note-id]'

interface NoteListProps {
  query: string
  onEdit: (id: string) => void
  onDeleted: (id: string) => void
  /** Called when the focused row went away and no row is left to take focus. */
  onFocusLost: () => void
}

/** Pinned first, then most recently edited; filtered by the search. Note text is always plain text. */
export function NoteList({ query, onEdit, onDeleted, onFocusLost }: NoteListProps) {
  const t = useT()
  const notes = useNotes((store) => store.notes)
  const now = useClock()
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const list = useRef<HTMLUListElement>(null)
  // The row action that holds focus, so focus can follow it when its row moves (Pin reorders) or
  // move on when the row is removed (Delete, filtered out) and the browser drops focus to <body>.
  const focused = useRef<FocusMemo | null>(null)

  const onListFocus = (event: FocusEvent<HTMLUListElement>) => {
    const target = event.target as HTMLElement
    const row = target.closest<HTMLElement>(ROW)
    if (!row || !list.current) return
    focused.current = {
      id: row.dataset['noteId'] ?? '',
      control: target.dataset['testid'] ?? null,
      index: [...list.current.querySelectorAll(ROW)].indexOf(row),
    }
  }
  const onListBlur = (event: FocusEvent<HTMLUListElement>) => {
    // Focus moved somewhere else on purpose; a removed or moved element blurs with no related target.
    if (event.relatedTarget && !list.current?.contains(event.relatedTarget)) focused.current = null
  }

  useLayoutEffect(() => {
    const memo = focused.current
    if (memo === null) return
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    focused.current = null
    const rows = list.current ? [...list.current.querySelectorAll<HTMLElement>(ROW)] : []
    const target = focusTarget(
      rows.map((row) => row.dataset['noteId'] ?? ''),
      memo,
    )
    const row = target ? rows[target.index] : undefined
    const button =
      (target?.control ? row?.querySelector<HTMLElement>(`[data-testid="${target.control}"]`) : null) ?? row?.querySelector('button')
    if (button) button.focus()
    else onFocusLost()
  })

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(null), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])

  const inFlight = useInFlight()

  // One call per note at a time: a double click on Delete never sends two deletes.
  const run: Run = (id, call, onOk) => {
    if (inFlight.has(id)) return
    setErrorKey(null)
    inFlight
      .run(id, call)
      .then((result) => {
        if (!result) return
        if (result.ok) onOk?.(result.data)
        else setErrorKey(noteErrorKey(result.error))
      })
      .catch(() => setErrorKey('error.generic'))
  }

  if (!notes) return null
  const visible = sortNotes(notes).filter((note) => matchesQuery(note, query))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* One live region for the list: the rows' times change every minute and must stay silent. */}
      <p role="status" className="sr-only">
        {copied ? t('notes.action.copied') : ''}
      </p>
      {errorKey && (
        <p role="alert" data-testid="notes-error" className="px-1 pb-1 text-label text-fail">
          {t(errorKey)}
        </p>
      )}
      {notes.length === 0 ? (
        <div data-testid="notes-empty" className="flex flex-1 flex-col items-center justify-center gap-1 pb-6 text-center">
          <p className="text-body text-chalk">{t('notes.list.empty')}</p>
          <p className="text-small text-graphite">{t('notes.list.emptyHint')}</p>
        </div>
      ) : visible.length === 0 ? (
        <div data-testid="notes-no-results" className="flex flex-1 items-center justify-center pb-6">
          <p className="text-body text-graphite">{t('notes.list.noResults')}</p>
        </div>
      ) : (
        <ul
          ref={list}
          aria-label={t('integration.notes')}
          data-testid="note-list"
          onFocus={onListFocus}
          onBlur={onListBlur}
          className="-mx-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1"
        >
          {visible.map((note) => (
            <NoteRow
              key={note.id}
              note={note}
              now={now}
              run={run}
              busy={inFlight.has(note.id)}
              copied={copied === note.id}
              onCopied={setCopied}
              onEdit={onEdit}
              onDeleted={onDeleted}
            />
          ))}
        </ul>
      )}
    </div>
  )
}
