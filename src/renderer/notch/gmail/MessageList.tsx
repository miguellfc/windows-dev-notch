import { MailOpen, Trash2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type Ref } from 'react'
import type { MessageKey } from '../../../shared/i18n/messages'
import type { GmailMessage } from '../../../shared/gmail/schema'
import { formatReceived, subjectText } from '../../shared/gmail/format'
import { useInFlight } from '../../shared/reminders/use-in-flight'
import { useClock } from '../../shared/use-clock'
import { locale, useLanguage, useT } from '../../shared/use-t'
import { radioKeyTarget } from '../../ui/roving'
import { DeleteConfirm } from './DeleteConfirm'

const ROW = '[data-testid="gmail-message"]'
const ITEM = '[data-message-id]'

/** Rows of a message list, in order. */
export const messageRows = (list: HTMLElement | null): HTMLElement[] =>
  list ? [...list.querySelectorAll<HTMLElement>(ROW)] : []

/** The row (the button that opens the message) of one message, if it is listed. */
export const messageRow = (list: HTMLElement | null, id: string): HTMLElement | null =>
  list?.querySelector<HTMLElement>(`${ITEM}[data-message-id="${CSS.escape(id)}"] ${ROW}`) ?? null

/** Up/Down (wrapping), Home and End move between rows; Enter is the row button's own click. */
const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') return
  const rows = messageRows(event.currentTarget)
  const from = rows.indexOf(document.activeElement as HTMLElement)
  // Only from a row: arrows inside the actions or the confirmation stay theirs.
  if (from === -1) return
  const to = radioKeyTarget(event.key, from, rows.length)
  if (to === null) return
  event.preventDefault()
  rows[to]?.focus()
}

type MailAction = 'markRead' | 'delete'

const FAILED: Readonly<Record<MailAction, MessageKey>> = {
  markRead: 'gmail.row.markReadFailed',
  delete: 'gmail.row.deleteFailed',
}

// Hidden until the row is hovered or holds focus (the system list's pattern); 24 px targets.
const actionButton =
  'flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-control-sm text-graphite transition-colors duration-150 hover:bg-veil-hover hover:text-chalk focus-inset aria-disabled:cursor-default aria-disabled:opacity-40'

/**
 * The actions cover the row's right edge, full height (the time included), on the row's own hover
 * colour: Velo over the dense panel.
 */
const overlay = 'absolute inset-y-0 right-0 flex rounded-r-tile bg-obsidian-dense'
// At least 96 px wide: the widest time ("hace 59 min", "59 min. ago") never peeks out at its left.
const overlayFill = 'flex h-full min-w-24 items-center justify-end rounded-r-tile bg-veil'

/** Calls main for a row action; resolves to whether it worked. */
const callAction = async (action: MailAction, id: string): Promise<boolean> => {
  try {
    const result = await (action === 'delete' ? window.notch.gmail.delete({ id }) : window.notch.gmail.markRead({ id }))
    return result.ok
  } catch {
    return false
  }
}

function MessageRow({
  message,
  now,
  onOpen,
  onAsk,
  onMarkRead,
  busy,
  failed,
}: {
  message: GmailMessage
  now: Date
  onOpen: () => void
  onAsk: () => void
  onMarkRead: () => void
  busy: boolean
  failed: MailAction | null
}) {
  const t = useT()
  const language = useLanguage()
  const received = formatReceived(message.date, now, language)
  const date = new Date(message.date)
  return (
    <>
      <button
        type="button"
        data-testid="gmail-message"
        data-unread={message.unread || undefined}
        onClick={onOpen}
        className="focus-inset flex h-[58px] w-full min-w-0 cursor-pointer flex-col justify-center gap-px rounded-tile px-2.5 text-left transition-colors duration-150 group-hover:bg-veil focus-visible:bg-veil"
      >
        <span className="flex w-full min-w-0 items-center gap-1.5">
          {/* The dot keeps its slot on read rows too, so every sender starts at the same x. */}
          <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${message.unread ? 'bg-ice' : ''}`} />
          {message.unread && <span className="sr-only">{t('gmail.view.unreadMark')}, </span>}
          {/* Mail text is always plain text: React escapes it, nothing is parsed as HTML. */}
          <span className={`min-w-0 flex-1 truncate text-body leading-[18px] text-chalk ${message.unread ? 'font-semibold' : ''}`}>
            {message.from}
          </span>
          {received && (
            <time
              dateTime={message.date}
              title={Number.isNaN(date.getTime()) ? undefined : new Intl.DateTimeFormat(locale(language), { dateStyle: 'medium', timeStyle: 'short' }).format(date)}
              className="tabular shrink-0 text-label leading-4 text-graphite"
            >
              {received}
            </time>
          )}
        </span>
        <span className={`w-full truncate pl-3 text-small leading-[17px] text-chalk ${message.unread ? 'font-medium' : ''}`}>
          {subjectText(message.subject, language)}
        </span>
        {message.snippet && <span className="w-full truncate pl-3 text-label leading-[15px] text-graphite">{message.snippet}</span>}
      </button>
      {failed ? (
        // A failed action stays visible in its row until retried or the row goes away.
        <span data-testid="gmail-row-error" className={overlay}>
          <span className={`${overlayFill} gap-1 pl-3 pr-1.5`}>
            <span className="text-label text-fail">{t(FAILED[failed])}</span>
            <span aria-hidden="true" className="text-label text-graphite">
              ·
            </span>
            <button
              type="button"
              data-testid="gmail-row-retry"
              aria-disabled={busy}
              onClick={() => {
                if (busy) return
                // A delete is permanent: retrying asks again.
                if (failed === 'delete') onAsk()
                else onMarkRead()
              }}
              className="h-6 shrink-0 cursor-pointer rounded-control-sm px-2 text-label font-medium text-chalk transition-colors duration-150 hover:bg-veil-hover focus-inset aria-disabled:cursor-default aria-disabled:opacity-40"
            >
              {t('gmail.row.retry')}
            </button>
          </span>
        </span>
      ) : (
        <span className={`${overlay} opacity-0 transition-opacity duration-150 group-has-[:focus-visible]:opacity-100 group-hover:opacity-100`}>
          <span className={`${overlayFill} gap-0.5 pl-2 pr-1.5`}>
            {message.unread && (
              <button
                type="button"
                data-testid="gmail-row-mark-read"
                aria-label={t('gmail.row.markRead')}
                title={t('gmail.row.markRead')}
                aria-disabled={busy}
                onClick={() => {
                  if (!busy) onMarkRead()
                }}
                className={actionButton}
              >
                <MailOpen size={14} strokeWidth={1.8} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              data-testid="gmail-row-delete"
              aria-label={t('gmail.row.delete')}
              title={t('gmail.row.delete')}
              aria-disabled={busy}
              onClick={() => {
                if (!busy) onAsk()
              }}
              className={actionButton}
            >
              <Trash2 size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </span>
        </span>
      )}
    </>
  )
}

/**
 * The 5 most recent messages in Primary; unread ones in bold with an ice-blue dot. A click or Enter
 * opens the reader; per-row Mark as read and Delete (behind an inline confirmation) appear on hover
 * or focus. `onFocusLost` is called when the focused row went away and no row is left.
 */
export function MessageList({
  messages,
  dimmed,
  onOpen,
  onMarkedRead,
  onDeleted,
  onFocusLost,
  ref,
}: {
  messages: readonly GmailMessage[]
  /** Offline: the last data, faded. */
  dimmed: boolean
  onOpen: (id: string) => void
  onMarkedRead: (id: string) => void
  onDeleted: (id: string) => void
  onFocusLost: () => void
  ref?: Ref<HTMLUListElement>
}) {
  const t = useT()
  const now = useClock()
  const inFlight = useInFlight()
  const [confirming, setConfirming] = useState<string | null>(null)
  const [failed, setFailed] = useState<Readonly<Record<string, MailAction>>>({})
  const list = useRef<HTMLUListElement | null>(null)
  const mounted = useRef(true)
  // Position of the item that holds focus, so focus can move on when its controls are replaced
  // (confirmation ↔ row, Mark as read gone) or the row itself is gone.
  const focusedIndex = useRef<number | null>(null)
  // Where focus goes once the confirmation closes without deleting: back to the trash button.
  const focusAfter = useRef<string | null>(null)

  // A question whose message left the list is dropped for good (adjusted during render).
  const asking = confirming !== null && messages.some((m) => m.id === confirming) ? confirming : null
  if (confirming !== null && asking === null) setConfirming(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const setListRef = (node: HTMLUListElement | null) => {
    list.current = node
    if (typeof ref === 'function') ref(node)
    else if (ref) ref.current = node
  }

  const onListFocus = (event: FocusEvent<HTMLUListElement>) => {
    const item = (event.target as HTMLElement).closest(ITEM)
    if (item && list.current) focusedIndex.current = [...list.current.querySelectorAll(ITEM)].indexOf(item)
  }
  const onListBlur = (event: FocusEvent<HTMLUListElement>) => {
    // Focus moved somewhere else on purpose; a removed element blurs with no related target.
    if (event.relatedTarget && !list.current?.contains(event.relatedTarget)) focusedIndex.current = null
  }

  useLayoutEffect(() => {
    const back = focusAfter.current
    if (back !== null) {
      focusAfter.current = null
      const trash = list.current?.querySelector<HTMLElement>(`${ITEM}[data-message-id="${CSS.escape(back)}"] [data-testid="gmail-row-delete"]`)
      if (trash) {
        trash.focus()
        return
      }
    }
    const index = focusedIndex.current
    if (index === null) return
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    focusedIndex.current = null
    // The same position (the next row once one is deleted), else the last row.
    const rows = messageRows(list.current)
    const row = rows[Math.min(index, rows.length - 1)]
    if (row) row.focus()
    else onFocusLost()
  })

  const fail = (id: string, action: MailAction | null) =>
    setFailed((current) => {
      if (action) return { ...current, [id]: action }
      const rest = { ...current }
      delete rest[id]
      return rest
    })

  const run = (id: string, action: MailAction) => {
    fail(id, null)
    void inFlight.run(id, () => callAction(action, id)).then((worked) => {
      // undefined: already running for this row; a call that settles after the view closed has nobody to tell.
      if (worked === undefined || !mounted.current) return
      if (action === 'delete') setConfirming((current) => (current === id ? null : current))
      if (!worked) fail(id, action)
      else if (action === 'delete') onDeleted(id)
      else onMarkedRead(id)
    })
  }

  return (
    <ul
      ref={setListRef}
      aria-label={t('gmail.view.list')}
      data-testid="gmail-list"
      data-dimmed={dimmed || undefined}
      onKeyDown={onListKeyDown}
      onFocus={onListFocus}
      onBlur={onListBlur}
      className={`-mx-1 flex min-h-0 flex-1 flex-col overflow-hidden px-1 transition-opacity duration-150 ${dimmed ? 'opacity-70' : ''}`}
    >
      {messages.map((message) => {
        const busy = inFlight.has(message.id)
        if (asking === message.id)
          return (
            <li
              key={message.id}
              data-message-id={message.id}
              data-testid="gmail-message-confirm"
              className="flex h-[58px] shrink-0 flex-col justify-center gap-1 rounded-tile bg-veil px-2.5"
            >
              <span className="truncate pl-3 text-label text-graphite">{message.from}</span>
              <DeleteConfirm
                busy={busy}
                className="pl-3"
                onCancel={() => {
                  focusAfter.current = message.id
                  setConfirming(null)
                }}
                onConfirm={() => run(message.id, 'delete')}
              />
            </li>
          )
        return (
          <li key={message.id} data-message-id={message.id} className="group relative flex shrink-0">
            <MessageRow
              message={message}
              now={now}
              busy={busy}
              failed={failed[message.id] ?? null}
              onOpen={() => onOpen(message.id)}
              onAsk={() => {
                fail(message.id, null)
                setConfirming(message.id)
              }}
              onMarkRead={() => run(message.id, 'markRead')}
            />
          </li>
        )
      })}
    </ul>
  )
}
