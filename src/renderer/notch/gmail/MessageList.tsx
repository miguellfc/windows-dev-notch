import type { KeyboardEvent, Ref } from 'react'
import type { GmailMessage } from '../../../shared/gmail/schema'
import { formatReceived, subjectText } from '../../shared/gmail/format'
import { useClock } from '../../shared/use-clock'
import { locale, useLanguage, useT } from '../../shared/use-t'
import { radioKeyTarget } from '../../ui/roving'

const ROW = '[data-testid="gmail-message"]'

/** Rows of a message list, in order. */
export const messageRows = (list: HTMLElement | null): HTMLElement[] =>
  list ? [...list.querySelectorAll<HTMLElement>(ROW)] : []

/** Up/Down (wrapping), Home and End move between rows; Enter is the row button's own click. */
const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') return
  const rows = messageRows(event.currentTarget)
  const from = rows.indexOf(document.activeElement as HTMLElement)
  const to = radioKeyTarget(event.key, from, rows.length)
  if (to === null) return
  event.preventDefault()
  rows[to]?.focus()
}

function MessageRow({ message, now }: { message: GmailMessage; now: Date }) {
  const t = useT()
  const language = useLanguage()
  const received = formatReceived(message.date, now, language)
  const date = new Date(message.date)
  return (
    <li className="flex shrink-0">
      <button
        type="button"
        data-testid="gmail-message"
        data-unread={message.unread || undefined}
        onClick={() => void window.notch.gmail.open({ id: message.id })}
        className="focus-inset flex h-[58px] w-full min-w-0 cursor-pointer flex-col justify-center gap-px rounded-tile px-2.5 text-left transition-colors duration-150 hover:bg-veil focus-visible:bg-veil"
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
    </li>
  )
}

/** The 5 most recent messages in Primary; unread ones in bold with an ice-blue dot. */
export function MessageList({
  messages,
  dimmed,
  ref,
}: {
  messages: readonly GmailMessage[]
  /** Offline: the last data, faded. */
  dimmed: boolean
  ref?: Ref<HTMLUListElement>
}) {
  const t = useT()
  const now = useClock()
  return (
    <ul
      ref={ref}
      aria-label={t('gmail.view.list')}
      data-testid="gmail-list"
      data-dimmed={dimmed || undefined}
      onKeyDown={onListKeyDown}
      className={`-mx-1 flex min-h-0 flex-1 flex-col overflow-hidden px-1 transition-opacity duration-150 ${dimmed ? 'opacity-70' : ''}`}
    >
      {messages.map((message) => (
        <MessageRow key={message.id} message={message} now={now} />
      ))}
    </ul>
  )
}
