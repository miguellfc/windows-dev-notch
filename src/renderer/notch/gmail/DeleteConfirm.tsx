import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useT } from '../../shared/use-t'
import { confirmArmed } from '../system/confirm-guard'

const confirmButton =
  'h-6 shrink-0 cursor-pointer rounded-control-sm px-2.5 text-label font-medium transition-colors duration-150 focus-inset aria-disabled:cursor-default aria-disabled:opacity-40'

/**
 * "¿Borrar para siempre? Cancelar · Borrar", inline in a row or the reader's footer. Deleting is
 * permanent: focus starts on Cancel (Enter right after the trash button cancels), Esc cancels, and
 * Borrar ignores activation for the first 300 ms so a double click never confirms.
 */
export function DeleteConfirm({
  busy,
  onCancel,
  onConfirm,
  className = '',
}: {
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
  className?: string
}) {
  const t = useT()
  const questionId = useId()
  const cancel = useRef<HTMLButtonElement>(null)
  const [openedAt] = useState(() => performance.now())

  // Before paint: focus never flashes onto the next row while the trash button is replaced.
  useLayoutEffect(() => cancel.current?.focus(), [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return
    // Esc cancels the question, not the view; once the call is out it can only wait.
    event.preventDefault()
    event.stopPropagation()
    if (!busy) onCancel()
  }

  return (
    <div role="group" aria-labelledby={questionId} data-testid="gmail-delete-confirm" onKeyDown={onKeyDown} className={`flex items-center gap-1.5 ${className}`}>
      <span id={questionId} className="min-w-0 flex-1 truncate text-small text-chalk">
        {t('gmail.confirm.question')}
      </span>
      <button
        ref={cancel}
        type="button"
        data-testid="gmail-delete-cancel"
        // aria-disabled, not disabled: a disabled button drops focus to <body>, where Esc would close the notch.
        aria-disabled={busy}
        onClick={() => {
          if (!busy) onCancel()
        }}
        className={`${confirmButton} text-graphite hover:bg-veil-tile hover:text-chalk aria-disabled:hover:bg-transparent aria-disabled:hover:text-graphite`}
      >
        {t('gmail.confirm.cancel')}
      </button>
      <button
        type="button"
        data-testid="gmail-delete-confirm-button"
        aria-disabled={busy}
        onClick={() => {
          if (!busy && confirmArmed(openedAt, performance.now())) onConfirm()
        }}
        className={`${confirmButton} bg-veil-tile text-fail hover:bg-veil-hover aria-disabled:hover:bg-veil-tile`}
      >
        {t('gmail.confirm.delete')}
      </button>
    </div>
  )
}
