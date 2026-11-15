import { ArrowLeft } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { MessageKey } from '../../../shared/i18n/messages'
import { NOTE_TEXT_MAX, type Note } from '../../../shared/notes/schema'
import { noteErrorKey, thrownNoteErrorKey, validateNoteText } from '../../shared/notes/format'
import { useT } from '../../shared/use-t'
import { headerIconButton } from '../reminders/styles'

const secondaryButton =
  'h-7 cursor-pointer rounded-control border border-line bg-veil-tile px-3 text-label font-medium text-chalk transition-colors duration-150 hover:bg-veil-hover'
const primaryButton =
  'h-7 cursor-pointer rounded-control bg-ice px-3 text-label font-medium text-abyss transition-opacity duration-150 hover:opacity-90 aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:opacity-40'

/**
 * New note (`note` null) or edit an existing one. Enter is a newline; Ctrl+Enter (or Cmd+Enter)
 * saves; Esc cancels back to the list. Validates locally first, then creates or updates in main.
 */
export function NoteEditor({ note, onDone }: { note: Note | null; onDone: () => void }) {
  const t = useT()
  const textarea = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState(note?.text ?? '')
  // Untouched draft of an existing note: saving closes instead, so a copy of the note that changed
  // elsewhere meanwhile never overwrites the newer text.
  const [dirty, setDirty] = useState(false)
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false) // blocks a second save in the same tick, before state re-renders

  useEffect(() => {
    const field = textarea.current
    if (!field) return
    field.focus()
    // Editing continues where the text ends, not at the start.
    field.setSelectionRange(field.value.length, field.value.length)
  }, [])

  const save = async () => {
    if (inFlight.current) return
    const invalid = validateNoteText(text)
    setErrorKey(invalid)
    if (invalid) return
    const trimmed = text.trim()
    // Untouched or unchanged: nothing to save, and updatedAt must not move.
    if (note && (!dirty || trimmed === note.text)) {
      onDone()
      return
    }
    inFlight.current = true
    setBusy(true)
    try {
      const result = note
        ? await window.notch.notes.update({ id: note.id, text: trimmed })
        : await window.notch.notes.create({ text: trimmed })
      if (result.ok) {
        onDone()
        return
      }
      setErrorKey(noteErrorKey(result.error))
    } catch (error) {
      setErrorKey(thrownNoteErrorKey(error, 'error.generic'))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const onTextKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return
    event.preventDefault()
    void save()
  }

  // Esc anywhere in the editor goes back to the list. Stopping here keeps the panel's Esc (back to
  // the integrations row) and NotchApp's window-level dismiss from also firing.
  const onEditorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onDone()
  }

  // Counted like the validation: leading and trailing whitespace is not saved.
  const length = text.trim().length
  const over = length > NOTE_TEXT_MAX
  const title = t(note ? 'notes.view.edit' : 'notes.view.new')

  return (
    // Focusable (not tabbable) so a click on a blank area keeps focus in the editor and Esc still
    // reaches onEditorKeyDown instead of NotchApp's window-level dismiss.
    <div data-testid="note-editor" tabIndex={-1} onKeyDown={onEditorKeyDown} className="flex min-h-0 flex-1 flex-col gap-2 outline-none">
      <header className="flex h-8 shrink-0 items-center gap-1">
        <button
          type="button"
          data-testid="note-editor-back"
          onClick={onDone}
          aria-label={t('notes.view.back')}
          title={t('notes.view.back')}
          className={headerIconButton}
        >
          <ArrowLeft size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <h2 className="ml-2 text-body font-medium text-chalk">{title}</h2>
      </header>
      <textarea
        ref={textarea}
        data-testid="note-editor-text"
        aria-label={t('notes.editor.label')}
        aria-invalid={errorKey !== null}
        aria-describedby={errorKey ? 'note-editor-error note-editor-counter' : 'note-editor-counter'}
        aria-keyshortcuts="Control+Enter"
        value={text}
        spellCheck={false}
        autoComplete="off"
        placeholder={t('notes.editor.placeholder')}
        onChange={(event) => {
          setText(event.target.value)
          setDirty(true)
          setErrorKey(null)
        }}
        onKeyDown={onTextKeyDown}
        className="min-h-0 flex-1 resize-none whitespace-pre-wrap break-words rounded-tile border border-line bg-veil px-3 py-2 text-body text-chalk placeholder:text-graphite aria-invalid:border-fail/60"
      />
      <div className="flex h-7 shrink-0 items-center gap-2">
        {errorKey && (
          <p id="note-editor-error" role="alert" data-testid="note-editor-error" className="min-w-0 truncate text-label text-fail">
            {t(errorKey, { max: NOTE_TEXT_MAX })}
          </p>
        )}
        <span
          id="note-editor-counter"
          data-testid="note-editor-counter"
          className={`tabular ml-auto shrink-0 text-label ${over ? 'text-fail' : 'text-graphite'}`}
        >
          <span aria-hidden="true">
            {length} / {NOTE_TEXT_MAX}
          </span>
          <span className="sr-only">{t('notes.editor.counter', { count: length, max: NOTE_TEXT_MAX })}</span>
        </span>
        <button type="button" data-testid="note-editor-cancel" onClick={onDone} className={secondaryButton}>
          {t('notes.editor.cancel')}
        </button>
        <button
          type="button"
          data-testid="note-editor-save"
          title={t('notes.editor.saveHint')}
          aria-keyshortcuts="Control+Enter"
          // aria-disabled, not disabled: a disabled button drops focus to <body>, where Esc would
          // dismiss the notch. save() is already a no-op while a call is in flight.
          aria-disabled={busy}
          onClick={() => void save()}
          className={primaryButton}
        >
          {t('notes.editor.save')}
        </button>
      </div>
    </div>
  )
}
