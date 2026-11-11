import { X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import type { MessageKey } from '../../../shared/i18n/messages'
import type { KillResult, ProcessOrder, ProcessRow } from '../../../shared/system/schema'
import { useInFlight } from '../../shared/reminders/use-in-flight'
import { useSystem } from '../../shared/system-store'
import { useLanguage, useT } from '../../shared/use-t'
import { confirmArmed } from './confirm-guard'
import { formatBytes, formatPercent } from './format'
import { freezeOrder, rowId, sortRows } from './process-order'

/** How long a kill result stays in its row. */
const MESSAGE_MS = 3000

const RESULT_MESSAGES: Readonly<Record<Exclude<KillResult, 'killed'>, MessageKey>> = {
  denied: 'system.process.denied',
  gone: 'system.process.gone',
  'not-killable': 'system.process.notKillable',
}

// Busy buttons use aria-disabled, not disabled: a disabled button drops focus to <body>, where Esc
// would dismiss the notch. The in-flight guard already makes a second click a no-op.
const closeButton =
  'flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-control-sm text-graphite opacity-0 transition-[color,background-color,opacity] duration-150 hover:bg-veil-tile hover:text-chalk group-hover:opacity-100 group-focus-within:opacity-100 focus-inset aria-disabled:cursor-default aria-disabled:opacity-40'
const confirmButton =
  'h-6 shrink-0 cursor-pointer rounded-control-sm px-2.5 text-label font-medium transition-colors duration-150 focus-inset aria-disabled:cursor-default aria-disabled:opacity-40'

const ROW = '[data-process-id]'
/** The button a row hands focus to: its ✕, or Cancel while it asks to confirm (never Close). */
const ROW_FOCUS = '[data-testid="process-close"], [data-testid="process-confirm-cancel"]'

interface Message {
  key: MessageKey
  tone: 'fail' | 'quiet'
}

/**
 * The top processes (at most 8, as main sends them) in the chosen order, with an inline
 * confirm-to-close on the rows main marked as killable. `onFocusLost` is called when the focused
 * row went away and no row is left to take focus.
 */
export function ProcessList({ order, onFocusLost }: { order: ProcessOrder; onFocusLost: () => void }) {
  const t = useT()
  const language = useLanguage()
  // Main already sends this order; sorting here too reorders the rows at once when the order
  // changes, instead of a tick later.
  const sorted = sortRows(
    useSystem((state) => state.processes),
    order,
  )
  // `frozen`: the row order when the question opened, kept while it is open.
  const [confirming, setConfirming] = useState<{ id: string; openedAt: number; frozen: string[] } | null>(null)
  // A question whose process left the list is dropped for good (adjusted during render), so it
  // can never come back later and pull focus to its Cancel.
  const asking = confirming && sorted.some((row) => rowId(row) === confirming.id) ? confirming : null
  if (confirming && !asking) setConfirming(null)
  // While a question is open the order is frozen: a CPU re-rank must not move it (or the row under
  // the pointer) every second.
  const rows = asking ? freezeOrder(sorted, asking.frozen) : sorted
  const [messages, setMessages] = useState<Readonly<Record<string, Message>>>({})
  // The list's one polite live region: each result is read once, wherever focus is.
  const [announcement, setAnnouncement] = useState('')
  const mounted = useRef(true)
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const inFlight = useInFlight()
  const list = useRef<HTMLUListElement>(null)
  // Position of the row that holds focus, so focus can move on when that row's controls are
  // replaced (confirm ↔ row) or the row itself is gone, and the browser drops focus to <body>.
  const focusedIndex = useRef<number | null>(null)

  useEffect(() => {
    mounted.current = true
    const pending = timers.current
    return () => {
      mounted.current = false
      pending.forEach((timer) => clearTimeout(timer))
    }
  }, [])

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
    // The same position first (its own ✕ after a confirm, or the next row), then the rows after
    // it, then the ones before; rows that cannot be closed have no button.
    const all = list.current ? [...list.current.querySelectorAll<HTMLElement>(ROW)] : []
    const ordered = [...all.slice(index), ...all.slice(0, index).reverse()]
    const button = ordered.map((row) => row.querySelector<HTMLElement>(ROW_FOCUS)).find((found) => found !== null)
    if (button) button.focus()
    else onFocusLost()
  })

  const showMessage = (id: string, message: Message) => {
    // A call that settles after the view closed has nobody to tell.
    if (!mounted.current) return
    setAnnouncement(t(message.key))
    setMessages((current) => ({ ...current, [id]: message }))
    clearTimeout(timers.current.get(id))
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id)
        setMessages((current) => {
          const rest = { ...current }
          delete rest[id]
          return rest
        })
      }, MESSAGE_MS),
    )
  }

  const kill = (row: ProcessRow) => {
    const id = rowId(row)
    void inFlight
      .run(id, () => window.notch.system.killProcess({ pid: row.pid, startTime: row.startTime }))
      .then((result) => {
        if (!result || !mounted.current) return
        setConfirming((current) => (current?.id === id ? null : current))
        // Killed: the row leaves on the next tick, which moves focus on.
        if (!result.ok) showMessage(id, { key: 'error.generic', tone: 'fail' })
        else if (result.data !== 'killed')
          showMessage(id, { key: RESULT_MESSAGES[result.data], tone: result.data === 'denied' ? 'fail' : 'quiet' })
      })
      .catch(() => {
        if (!mounted.current) return
        setConfirming((current) => (current?.id === id ? null : current))
        showMessage(id, { key: 'error.generic', tone: 'fail' })
      })
  }

  const liveRegion = (
    <p role="status" aria-live="polite" data-testid="process-announcement" className="sr-only">
      {announcement}
    </p>
  )

  if (rows.length === 0)
    return (
      <>
        <p data-testid="system-processes-loading" className="flex min-h-0 flex-1 items-center justify-center text-small text-graphite">
          {t('system.processes.loading')}
        </p>
        {liveRegion}
      </>
    )

  return (
    <>
      <ul
        ref={list}
        aria-label={t('system.processes.label')}
        data-testid="process-list"
        onFocus={onListFocus}
        onBlur={onListBlur}
        className="-mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto px-1"
      >
        {rows.map((row) => {
          const id = rowId(row)
          const busy = inFlight.has(id)
          const cpu = formatPercent(row.cpuPercent, language)
          const ram = row.privateBytes === null ? '—' : formatBytes(row.privateBytes, language)
          const message = messages[id]

          if (asking?.id === id) {
            const openedAt = asking.openedAt
            const questionId = `process-question-${row.pid}`
            const question = t('system.process.confirm', { name: row.name, pid: row.pid })
            const onKeyDown = (event: KeyboardEvent<HTMLLIElement>) => {
              if (event.key !== 'Escape') return
              // Esc cancels the question (not the view); once the call is out it can only wait.
              event.preventDefault()
              event.stopPropagation()
              if (!busy) setConfirming(null)
            }
            return (
              <li
                key={id}
                data-process-id={id}
                data-testid="process-confirm"
                onKeyDown={onKeyDown}
                className="flex h-6 shrink-0 items-center gap-1.5 rounded-control-sm bg-veil pl-2"
              >
                <span id={questionId} title={question} className="min-w-0 flex-1 truncate text-small text-chalk">
                  {question}
                </span>
                {/* Close sits left of Cancel: the ✕ that opened the question was at the right edge,
                    so a double click lands its second click on Cancel. Close also ignores
                    activation for 300 ms after the question opens. */}
                <button
                  type="button"
                  data-testid="process-confirm-close"
                  aria-disabled={busy}
                  aria-describedby={questionId}
                  onClick={() => {
                    if (!busy && confirmArmed(openedAt, performance.now())) kill(row)
                  }}
                  className={`${confirmButton} bg-veil-tile text-fail hover:bg-veil-hover aria-disabled:hover:bg-veil-tile`}
                >
                  {t('system.process.confirmClose')}
                </button>
                <CancelButton
                  busy={busy}
                  describedBy={questionId}
                  onCancel={() => setConfirming(null)}
                  label={t('system.process.cancel')}
                />
              </li>
            )
          }

          return (
            <li
              key={id}
              data-process-id={id}
              data-testid="process-row"
              data-pid={row.pid}
              className="group flex h-6 shrink-0 items-center gap-2 rounded-control-sm pl-2 hover:bg-veil"
            >
              <span title={row.name} className="min-w-0 flex-1 truncate text-small text-chalk">
                {row.name}
              </span>
              {message ? (
                // Shown in the row; screen readers hear it from the list's live region.
                <span aria-hidden="true" className={`shrink-0 truncate text-label ${message.tone === 'fail' ? 'text-fail' : 'text-graphite'}`}>
                  {t(message.key)}
                </span>
              ) : (
                <>
                  <span className={`tabular w-12 shrink-0 text-right text-small ${order === 'cpu' ? 'text-chalk' : 'text-graphite'}`}>
                    <span className="sr-only">{t('system.card.cpu')} </span>
                    {cpu}
                  </span>
                  <span className={`tabular w-16 shrink-0 text-right text-small ${order === 'ram' ? 'text-chalk' : 'text-graphite'}`}>
                    <span className="sr-only">{t('system.card.ram')} </span>
                    {ram}
                  </span>
                </>
              )}
              {row.killable ? (
                <button
                  type="button"
                  data-testid="process-close"
                  aria-label={t('system.process.close', { name: row.name })}
                  title={t('system.process.close', { name: row.name })}
                  aria-disabled={busy}
                  onClick={() => {
                    if (!busy) setConfirming({ id, openedAt: performance.now(), frozen: rows.map(rowId) })
                  }}
                  className={closeButton}
                >
                  <X size={14} strokeWidth={1.8} aria-hidden="true" />
                </button>
              ) : (
                <span aria-hidden="true" className="size-6 shrink-0" />
              )}
            </li>
          )
        })}
      </ul>
      {liveRegion}
    </>
  )
}

/** Takes focus when the question appears: Enter right after ✕ must not close the process. */
function CancelButton({
  busy,
  describedBy,
  onCancel,
  label,
}: {
  busy: boolean
  describedBy: string
  onCancel: () => void
  label: string
}) {
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => button.current?.focus(), [])
  return (
    <button
      ref={button}
      type="button"
      data-testid="process-confirm-cancel"
      aria-disabled={busy}
      aria-describedby={describedBy}
      onClick={() => {
        if (!busy) onCancel()
      }}
      className={`${confirmButton} text-graphite hover:bg-veil-tile hover:text-chalk aria-disabled:hover:bg-transparent aria-disabled:hover:text-graphite`}
    >
      {label}
    </button>
  )
}
