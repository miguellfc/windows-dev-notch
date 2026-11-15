import { ArrowLeft, ExternalLink, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { GmailState } from '../../../shared/gmail/schema'
import { setReading, useGmail } from '../../shared/gmail-store'
import { formatUpdated, gmailBody, returnRowIndex, unreadText, type GmailRecent } from '../../shared/gmail/format'
import { useClock } from '../../shared/use-clock'
import { useLanguage, useT } from '../../shared/use-t'
import { headerIconButton } from '../reminders/styles'
import { GmailSkeleton, GmailStatus } from './GmailStatus'
import { MessageList, messageRow, messageRows } from './MessageList'
import { MessageReader } from './MessageReader'

/** Main asks Gmail at most once per 5 s on a manual refresh; the button rests as long. */
const REFRESH_REST_MS = 5_000

const isLive = (state: GmailState | null): state is GmailState => state?.status === 'ok' || state?.status === 'offline'

/**
 * Esc anywhere in the view goes back to the integrations row instead of closing the notch. React's
 * stopPropagation also stops the native bubble, so NotchApp's window-level dismiss never sees it.
 * ArrowDown/Home from outside the list jump into it.
 */
function onPanelKeyDown(event: KeyboardEvent<HTMLDivElement>, list: HTMLUListElement | null) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    void window.notch.notch.back()
    return
  }
  if ((event.key === 'ArrowDown' || event.key === 'Home') && list && !list.contains(document.activeElement)) {
    const first = messageRows(list)[0]
    if (!first) return
    event.preventDefault()
    first.focus()
  }
}

/** Adds an id to a set kept in state (a new set, so React sees the change). */
const withId = (set: ReadonlySet<string>, id: string): ReadonlySet<string> => (set.has(id) ? set : new Set([...set, id]))

/**
 * The Gmail mini tool: the 5 most recent messages in Primary (or why there are none), and the reader
 * of one of them. The reader's id lives in the store: the panel takes the reader's size, and the
 * mail alert can open a message directly.
 */
export function GmailView() {
  const t = useT()
  const language = useLanguage()
  const now = useClock()
  const state = useGmail((store) => store.state)
  const reading = useGmail((store) => store.reading)
  // What this view already did, shown before main's next list arrives: read rows lose their
  // mark, deleted rows go at once (a deleted id never comes back).
  const [markedRead, setMarkedRead] = useState<ReadonlySet<string>>(() => new Set())
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(() => new Set())
  // The row to focus when the list comes back from the reader: that message and its index then.
  const returnTo = useRef<{ id: string; index: number } | null>(null)
  // The rows as last rendered, to know the open message's index.
  const shownIds = useRef<readonly string[]>([])
  const [recent, setRecent] = useState<GmailRecent | null>(null)
  const [resting, setResting] = useState(false)
  const [openedAt] = useState(() => Date.now())
  const panel = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)

  // Main polls the list only while the view is open. NotchApp forgets the open message when the
  // mode leaves the view (not here: StrictMode's mount-cleanup-mount would drop an alert's reader).
  useEffect(() => {
    void window.notch.gmail.view({ open: true })
    return () => void window.notch.gmail.view({ open: false })
  }, [])

  // Every reading (a poll, a status change) may carry a new list: ask again. The first answer can
  // predate the poll that opening the view starts; the reading that poll publishes asks once more.
  const status = state?.status
  const updatedAt = state?.updatedAt ?? null
  useEffect(() => {
    if (status !== 'ok' && status !== 'offline') return
    let current = true
    void window.notch.gmail.recent().then((result) => {
      if (current && result.ok) setRecent({ messages: result.data, forUpdate: updatedAt })
    })
    return () => {
      current = false
    }
  }, [status, updatedAt])

  useEffect(() => {
    if (!resting) return
    const timer = setTimeout(() => setResting(false), REFRESH_REST_MS)
    return () => clearTimeout(timer)
  }, [resting])

  // Back from the reader: focus the row of the message that was open, or the row that took its
  // place once it was deleted (the last row if it was the last one).
  useLayoutEffect(() => {
    const from = returnTo.current
    if (from === null || reading !== null || !list.current) return
    returnTo.current = null
    const rows = messageRows(list.current)
    const ids = rows.map((row) => row.closest<HTMLElement>('[data-message-id]')?.dataset.messageId ?? '')
    const index = returnRowIndex(ids, from)
    ;(messageRow(list.current, from.id) ?? (index === null ? null : rows[index]))?.focus()
  })

  // The tile that opened the view unmounts: keep focus in the panel so Esc goes back to the row.
  useLayoutEffect(() => {
    if (reading !== null) return
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    panel.current?.focus()
  })

  const refresh = () => {
    if (resting) return
    setResting(true)
    void window.notch.gmail.refresh()
  }

  const onMarkedRead = useCallback((id: string) => setMarkedRead((set) => withId(set, id)), [])
  const onDeleted = useCallback((id: string) => {
    setDeleted((set) => withId(set, id))
    // Deleted from the reader: back to the list, focus on the row that took its place.
    if (useGmail.getState().reading === id) {
      returnTo.current = { id, index: shownIds.current.indexOf(id) }
      setReading(null)
    }
  }, [])
  const openReader = useCallback((id: string) => setReading(id), [])
  const closeReader = useCallback(() => {
    const id = useGmail.getState().reading
    if (id !== null) returnTo.current = { id, index: shownIds.current.indexOf(id) }
    setReading(null)
  }, [])

  const shown = useMemo<GmailRecent | null>(
    () =>
      recent && {
        ...recent,
        messages: recent.messages.filter((m) => !deleted.has(m.id)).map((m) => (m.unread && markedRead.has(m.id) ? { ...m, unread: false } : m)),
      },
    [recent, deleted, markedRead],
  )

  // Kept from the last list shown (not while reading), when its index is still the row's.
  useEffect(() => {
    if (reading === null && shown) shownIds.current = shown.messages.map((m) => m.id)
  }, [reading, shown])

  if (reading !== null) return <MessageReader key={reading} id={reading} onBack={closeReader} onMarkedRead={onMarkedRead} onDeleted={onDeleted} />

  const body = gmailBody(state, shown, openedAt)
  const live = isLive(state)
  const offline = state?.status === 'offline'
  const updated = offline ? formatUpdated(state.updatedAt, now, language) : ''

  return (
    // Focusable (not tabbable): a click on a blank area keeps focus in the panel, so Esc reaches
    // the panel (back to the row) instead of NotchApp's window-level dismiss.
    <div
      ref={panel}
      role="region"
      aria-label={t('integration.gmail')}
      data-testid="gmail-panel"
      tabIndex={-1}
      onKeyDown={(event) => onPanelKeyDown(event, list.current)}
      className="flex h-full flex-col gap-2 px-3 pb-2.5 pt-2 outline-none"
    >
      <header className="flex h-8 shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => void window.notch.notch.back()}
          aria-label={t('gmail.view.back')}
          title={t('gmail.view.back')}
          className={headerIconButton}
        >
          <ArrowLeft size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <h2 className="ml-2 shrink-0 text-body font-medium text-chalk">{t('integration.gmail')}</h2>
        {live && state.unread !== null && state.unread > 0 && (
          <span data-testid="gmail-unread" className="tabular ml-1 truncate text-small text-graphite">
            {t('gmail.view.unread', { count: unreadText(state.unread) })}
          </span>
        )}
        {live && (
          <button
            type="button"
            data-testid="gmail-refresh"
            onClick={refresh}
            // aria-disabled, not disabled: a disabled button drops focus to <body>, where Esc would close the notch.
            aria-disabled={resting}
            aria-label={t('gmail.view.refresh')}
            title={t('gmail.view.refresh')}
            className={`${headerIconButton} ml-auto aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-graphite`}
          >
            <RefreshCw size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        )}
      </header>

      {body === 'loading' ? (
        <GmailSkeleton />
      ) : body === 'list' && shown ? (
        <MessageList
          ref={list}
          messages={shown.messages}
          dimmed={offline}
          onOpen={openReader}
          onMarkedRead={onMarkedRead}
          onDeleted={onDeleted}
          onFocusLost={() => panel.current?.focus()}
        />
      ) : (
        <GmailStatus notice={body === 'list' ? 'empty' : body} />
      )}

      {live && (
        <footer className="flex h-6 shrink-0 items-center gap-2 px-1">
          {offline && (
            <span data-testid="gmail-offline" className="min-w-0 truncate text-label text-graphite">
              {t('gmail.view.offline')}
              {updated && ` · ${updated}`}
            </span>
          )}
          <button
            type="button"
            data-testid="gmail-open-inbox"
            onClick={() => void window.notch.gmail.open({})}
            className="ml-auto flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-control-sm px-2 text-label font-medium text-chalk transition-colors duration-150 hover:bg-veil-tile"
          >
            {t('gmail.view.openGmail')}
            <ExternalLink size={12} strokeWidth={1.8} aria-hidden="true" className="text-graphite" />
          </button>
        </footer>
      )}
    </div>
  )
}
