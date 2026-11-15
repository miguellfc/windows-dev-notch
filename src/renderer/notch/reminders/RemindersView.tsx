import { ArrowLeft, Plus } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { NoticeBanner } from '../../shared/reminders/RemindersNotice'
import { useT } from '../../shared/use-t'
import { ReminderForm } from './ReminderForm'
import { headerIconButton } from './styles'
import { ReminderList } from './ReminderList'

/**
 * Esc anywhere in the list (e.g. on a row button) goes back to the integrations row instead of
 * closing the notch. The form handles its own Esc first (back to the list) and stops propagation.
 * React's stopPropagation also stops the native bubble, so NotchApp's window-level Esc dismiss
 * never sees it.
 */
const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  void window.notch.notch.back()
}

/** The reminders mini tool: the list with a "+" that swaps it for the new-reminder form. */
export function RemindersView() {
  const t = useT()
  const [screen, setScreen] = useState<'list' | 'form'>('list')
  const addButton = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  // The tile that opened the view unmounts, and so does the form on its way back: keep focus in
  // the panel (on "+") so the keyboard, and the panel's Esc, keep working.
  useEffect(() => {
    if (screen === 'list') addButton.current?.focus()
  }, [screen])

  return (
    // Focusable (not tabbable): a click on a blank area keeps focus in the panel, so Esc reaches
    // onPanelKeyDown (back to the row) instead of NotchApp's window-level dismiss.
    <div
      ref={panel}
      data-testid="reminders-panel"
      tabIndex={-1}
      onKeyDown={onPanelKeyDown}
      className="flex h-full flex-col gap-2 px-3 pb-3 pt-2 outline-none"
    >
      {screen === 'list' ? (
        <>
          <header className="flex h-8 shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => void window.notch.notch.back()}
              aria-label={t('reminders.view.back')}
              title={t('reminders.view.back')}
              className={headerIconButton}
            >
              <ArrowLeft size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
            <button
              ref={addButton}
              type="button"
              data-testid="reminders-add"
              onClick={() => setScreen('form')}
              aria-label={t('reminders.view.new')}
              title={t('reminders.view.new')}
              className={headerIconButton}
            >
              <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
            <h2 className="ml-2 text-body font-medium text-chalk">{t('integration.reminders')}</h2>
            <button
              type="button"
              data-testid="reminders-see-all"
              onClick={() => void window.notch.app.openControlCenter()}
              className="ml-auto cursor-pointer rounded-control-sm px-2 py-1 text-label font-medium text-graphite transition-colors duration-150 hover:bg-veil-tile hover:text-chalk"
            >
              {t('reminders.view.seeAll')}
            </button>
          </header>
          <NoticeBanner />
          <ReminderList onFocusLost={() => (addButton.current ?? panel.current)?.focus()} />
        </>
      ) : (
        <ReminderForm onDone={() => setScreen('list')} />
      )}
    </div>
  )
}
