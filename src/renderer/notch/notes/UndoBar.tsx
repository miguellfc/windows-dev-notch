import { useEffect, useRef, useState } from 'react'
import type { MessageKey } from '../../../shared/i18n/messages'
import { thrownNoteErrorKey, undoErrorKey } from '../../shared/notes/format'
import { useT } from '../../shared/use-t'

/** How long the bar offers Undo; main keeps a deleted note restorable for 10 s. */
export const UNDO_MS = 5000

const undoButton =
  'h-6 shrink-0 cursor-pointer rounded-control-sm px-2 text-label font-medium text-chalk transition-colors duration-150 hover:bg-veil-tile focus-inset aria-disabled:cursor-default aria-disabled:opacity-40'

/**
 * "Nota borrada · Deshacer" for 5 s after a delete. A newer delete takes the bar over with its own 5 s;
 * after undoing it, an earlier delete still inside its 5 s is offered again for the time it has left.
 */
export function UndoBar({
  noteId,
  expiresAt,
  onRestored,
  onExpired,
}: {
  noteId: string
  /** `Date.now()` value at which the offer ends. */
  expiresAt: number
  onRestored: (id: string) => void
  onExpired: () => void
}) {
  const t = useT()
  const [failedKey, setFailedKey] = useState<MessageKey | null>(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const expired = useRef(onExpired)
  useEffect(() => {
    expired.current = onExpired
  }, [onExpired])

  useEffect(() => {
    const timer = setTimeout(() => expired.current(), Math.max(0, expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [expiresAt])

  const undo = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      const result = await window.notch.notes.restore({ id: noteId })
      if (result.ok) {
        onRestored(noteId)
        return
      }
      setFailedKey(undoErrorKey(result.error))
    } catch (error) {
      setFailedKey(thrownNoteErrorKey(error, 'notes.undo.failed'))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <div
      role="status"
      data-testid="notes-undo"
      className="flex h-8 shrink-0 items-center gap-2 rounded-tile border border-line bg-veil pl-2.5 pr-1"
    >
      <span className="min-w-0 truncate text-small text-graphite">{t(failedKey ?? 'notes.undo.deleted')}</span>
      {!failedKey && (
        <>
          <span aria-hidden="true" className="text-small text-graphite">
            ·
          </span>
          <button
            type="button"
            data-testid="notes-undo-button"
            aria-disabled={busy}
            onClick={() => void undo()}
            className={undoButton}
          >
            {t('notes.undo.action')}
          </button>
        </>
      )}
    </div>
  )
}
