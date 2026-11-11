import { Check, Repeat, Trash2 } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent } from 'react'
import type { MessageKey } from '../../../shared/i18n/messages'
import type { Result } from '../../../shared/ipc/result'
import type { Reminder } from '../../../shared/reminders/schema'
import { useReminders } from '../../shared/reminders-store'
import { useSettings } from '../../shared/settings-store'
import { useClock } from '../../shared/use-clock'
import { useLanguage, useT } from '../../shared/use-t'
import { attentionReminders, formatDue, reminderErrorKey, pendingReminders } from '../../shared/reminders/format'
import { useInFlight } from '../../shared/reminders/use-in-flight'

type Run = (id: string, call: () => Promise<Result<unknown>>) => void

// Busy buttons use aria-disabled, not disabled: a disabled button drops focus to <body>, where Esc
// would dismiss the notch. run() is already a no-op while the reminder's call is in flight.
const iconButton =
  'flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[8px] text-graphite transition-colors duration-150 hover:bg-veil-tile hover:text-chalk aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-graphite'
const textButton =
  'h-7 shrink-0 cursor-pointer rounded-control border border-line bg-veil-tile px-2.5 text-label font-medium text-chalk transition-colors duration-150 hover:bg-[rgba(255,255,255,0.09)] aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-veil-tile'

function RepeatMark({ repeat }: { repeat: Reminder['repeat'] }) {
  const t = useT()
  if (repeat === 'none') return null
  const label = t(repeat === 'daily' ? 'reminders.repeat.daily' : 'reminders.repeat.weekdays')
  return <Repeat size={12} strokeWidth={1.8} role="img" aria-label={label} className="shrink-0 text-graphite" />
}

/** A due or missed reminder: Snooze and Complete always visible. */
function AttentionRow({ reminder, now, run, busy }: { reminder: Reminder; now: Date; run: Run; busy: boolean }) {
  const t = useT()
  const language = useLanguage()
  const snoozeMinutes = useSettings((state) => state.settings?.reminders.snoozeMinutes ?? 10)
  return (
    <li data-testid="reminder-item" data-reminder-id={reminder.id} data-state={reminder.state} className="flex items-center gap-2 rounded-tile bg-veil px-2.5 py-1.5">
      <span className="status-dot" style={{ '--dot': 'var(--color-wait)' } as CSSProperties} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-body text-chalk">{reminder.text}</p>
        <p className="tabular flex items-center gap-1 text-label text-wait">
          <span>{t(reminder.state === 'missed' ? 'reminders.state.missed' : 'reminders.state.due')}</span>
          <span aria-hidden="true">·</span>
          <span className="text-graphite">{formatDue(new Date(reminder.dueAt), now, language)}</span>
          <RepeatMark repeat={reminder.repeat} />
        </p>
      </div>
      <button
        type="button"
        className={textButton}
        aria-disabled={busy}
        onClick={() => run(reminder.id, () => window.notch.reminders.snooze({ id: reminder.id }))}
      >
        {t('reminders.action.snooze', { minutes: snoozeMinutes })}
      </button>
      <button
        type="button"
        className={textButton}
        aria-disabled={busy}
        onClick={() => run(reminder.id, () => window.notch.reminders.complete({ id: reminder.id }))}
      >
        {t('reminders.action.complete')}
      </button>
    </li>
  )
}

/** A pending reminder: Complete and Delete appear on hover or focus. */
function UpcomingRow({ reminder, now, run, busy }: { reminder: Reminder; now: Date; run: Run; busy: boolean }) {
  const t = useT()
  const language = useLanguage()
  return (
    <li data-testid="reminder-item" data-reminder-id={reminder.id} data-state={reminder.state} className="group flex h-8 items-center gap-2 rounded-tile px-2.5 hover:bg-veil">
      <span className="tabular w-[118px] shrink-0 truncate text-small text-graphite">
        {formatDue(new Date(reminder.dueAt), now, language)}
      </span>
      <span className="min-w-0 truncate text-body text-chalk">{reminder.text}</span>
      <RepeatMark repeat={reminder.repeat} />
      <span className="ml-auto flex shrink-0 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          aria-label={t('reminders.action.completeItem', { text: reminder.text })}
          title={t('reminders.action.complete')}
          className={iconButton}
          aria-disabled={busy}
          onClick={() => run(reminder.id, () => window.notch.reminders.complete({ id: reminder.id }))}
        >
          <Check size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={t('reminders.action.deleteItem', { text: reminder.text })}
          title={t('reminders.action.deleteItem', { text: reminder.text })}
          className={iconButton}
          aria-disabled={busy}
          onClick={() => run(reminder.id, () => window.notch.reminders.delete({ id: reminder.id }))}
        >
          <Trash2 size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </span>
    </li>
  )
}

const ROW = '[data-reminder-id]'

/**
 * Due and missed first (oldest first), then every pending reminder (soonest first). Text is always plain text.
 * `onFocusLost` is called when the focused row went away and no row is left to take focus.
 */
export function ReminderList({ onFocusLost }: { onFocusLost: () => void }) {
  const t = useT()
  const reminders = useReminders((store) => store.reminders)
  const now = useClock()
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null)
  const list = useRef<HTMLUListElement>(null)
  // Position of the row that holds focus, so focus can move on when that row is removed
  // (Complete, Delete) or moves to another section (Snooze) and the browser drops it to <body>.
  const focusedIndex = useRef<number | null>(null)

  const onListFocus = (event: FocusEvent<HTMLUListElement>) => {
    const row = (event.target as HTMLElement).closest(ROW)
    if (row && list.current) focusedIndex.current = [...list.current.querySelectorAll(ROW)].indexOf(row)
  }
  const onListBlur = (event: FocusEvent<HTMLUListElement>) => {
    // Focus moved somewhere else on purpose; a removed element blurs with no related target.
    if (event.relatedTarget && !list.current?.contains(event.relatedTarget)) focusedIndex.current = null
  }

  useLayoutEffect(() => {
    const index = focusedIndex.current
    if (index === null) return
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    focusedIndex.current = null
    // The next row (now at the same position), else the last one; its first action takes focus.
    const rows = list.current ? [...list.current.querySelectorAll<HTMLElement>(ROW)] : []
    const button = (rows[index] ?? rows.at(-1))?.querySelector('button')
    if (button) button.focus()
    else onFocusLost()
  })

  const inFlight = useInFlight()

  // One call per reminder at a time: the row's buttons stay disabled until it settles, so a
  // double click on Complete of a repeating reminder cannot skip an occurrence.
  const run: Run = (id, call) => {
    if (inFlight.has(id)) return
    setErrorKey(null)
    inFlight
      .run(id, call)
      .then((result) => {
        if (result && !result.ok) setErrorKey(reminderErrorKey(result.error))
      })
      .catch(() => setErrorKey('error.generic'))
  }

  if (!reminders) return null
  const attention = attentionReminders(reminders)
  const upcoming = pendingReminders(reminders)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {errorKey && (
        <p role="alert" className="px-1 pb-1 text-label text-fail">
          {t(errorKey)}
        </p>
      )}
      {attention.length + upcoming.length === 0 ? (
        <div data-testid="reminders-empty" className="flex flex-1 flex-col items-center justify-center gap-1 pb-6 text-center">
          <p className="text-body text-chalk">{t('reminders.list.empty')}</p>
          <p className="text-small text-graphite">{t('reminders.list.emptyHint')}</p>
        </div>
      ) : (
        <ul
          ref={list}
          aria-label={t('integration.reminders')}
          data-testid="reminder-list"
          onFocus={onListFocus}
          onBlur={onListBlur}
          className="-mx-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1">
          {attention.map((reminder) => (
            <AttentionRow key={reminder.id} reminder={reminder} now={now} run={run} busy={inFlight.has(reminder.id)} />
          ))}
          {upcoming.map((reminder) => (
            <UpcomingRow key={reminder.id} reminder={reminder} now={now} run={run} busy={inFlight.has(reminder.id)} />
          ))}
        </ul>
      )}
    </div>
  )
}
