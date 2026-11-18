import { ArrowLeft, CloudOff, KeyRound, ListTodo, RefreshCw, Search, type LucideIcon } from 'lucide-react'
import { integrationStyle, useIntegration } from '../../shared/integration-color'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { MessageKey } from '../../../shared/i18n/messages'
import type { RedmineIssueList as IssueList } from '../../../shared/redmine/schema'
import { RedmineMark } from '../../shared/brand-icons'
import { formatUpdated } from '../../shared/gmail/format'
import { matchesIssue } from '../../shared/redmine/format'
import { loadSummary, useRedmine } from '../../shared/redmine-store'
import { useClock } from '../../shared/use-clock'
import { useLanguage, useT } from '../../shared/use-t'
import { headerIconButton } from '../reminders/styles'
import { RedmineIssueDetail } from './RedmineIssueDetail'
import { issueRow, issueRows, RedmineIssueList } from './RedmineIssueList'
import { RedmineSummary } from './RedmineSummary'

/** Main queries at most once per 5 s on a manual refresh; the button rests as long. */
const REFRESH_REST_MS = 5_000

type Notice = 'unconfigured' | 'auth' | 'empty' | 'error'

/** What each notice offers: Control Center (no session or a rejected key), Retry (the list could not be read), or nothing. */
const NOTICES: Readonly<Record<Notice, { icon: LucideIcon; title: MessageKey; action: 'control-center' | 'retry' | null }>> = {
  unconfigured: { icon: RedmineMark, title: 'redmine.state.unconfigured', action: 'control-center' },
  auth: { icon: KeyRound, title: 'redmine.state.auth', action: 'control-center' },
  empty: { icon: ListTodo, title: 'redmine.state.empty', action: null },
  error: { icon: CloudOff, title: 'redmine.state.listFailed', action: 'retry' },
}

const button =
  'btn h-8 px-3'

/** Everything the view shows instead of the list, with a way to Control Center when it helps. */
function RedmineStatus({ notice, onRetry }: { notice: Notice; onRetry: () => void }) {
  const t = useT()
  const { icon: Icon, title, action } = NOTICES[notice]
  return (
    <div role="status" data-testid="redmine-status" data-notice={notice} className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 pb-4 text-center">
      <Icon size={20} strokeWidth={1.8} aria-hidden="true" className="text-graphite" />
      <p className="text-body text-chalk">{t(title)}</p>
      {action === 'retry' && (
        <button type="button" data-testid="redmine-list-retry" onClick={onRetry} className={`${button} mt-1`}>
          {t('redmine.state.retry')}
        </button>
      )}
      {action === 'control-center' && (
        <button
          type="button"
          data-testid="redmine-open-control-center"
          onClick={() => void window.notch.app.openControlCenter({ page: 'redmine' })}
          className={`${button} mt-1`}
        >
          {t('redmine.state.openControlCenter')}
        </button>
      )}
    </div>
  )
}

/** Placeholder rows while the first list loads; the pulse stops with reduced motion. */
function RedmineSkeleton() {
  const t = useT()
  return (
    <div data-testid="redmine-loading" aria-busy="true" className="-mx-1 flex min-h-0 flex-1 flex-col overflow-hidden px-1">
      <p role="status" className="sr-only">
        {t('redmine.state.loading')}
      </p>
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} aria-hidden="true" className="flex h-[50px] shrink-0 flex-col justify-center gap-2 px-2.5">
          <span className="h-2.5 w-3/4 animate-pulse rounded-full bg-veil-tile motion-reduce:animate-none" />
          <span className="h-2 w-2/5 animate-pulse rounded-full bg-veil motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  )
}

/**
 * The Redmine mini tool: the hours summary (month chart and Hoy · Semana · Mes), the search box and
 * the assigned open issues; a row opens the issue's detail in place of all three. Keyboard: arrows
 * between rows, Enter opens the detail; Esc clears the search, then closes the detail (back to its
 * row), then goes back to the integrations row. Opening the view tells main (the month summary is
 * queried only while it is open) and asks for a query now; every new reading asks for the list again.
 */
export function RedmineView() {
  const t = useT()
  const language = useLanguage()
  const now = useClock()
  const state = useRedmine((store) => store.state)
  const [list, setList] = useState<IssueList | null>(null)
  // The last `issues()` call failed: without a list yet the view offers Retry instead of loading forever.
  const [listFailed, setListFailed] = useState(false)
  const [listAttempt, setListAttempt] = useState(0)
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<number | null>(null)
  const [resting, setResting] = useState(false)
  const pendingFocus = useRef<number | 'detail' | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const { color } = useIntegration('redmine')
  const scroller = useRef<HTMLDivElement>(null)
  const detail = useRef<HTMLDivElement>(null)

  const status = state?.status
  const updatedAt = state?.updatedAt ?? null

  // Listen first, then say the view opened, so no summary change is missed; then ask for a query now.
  useEffect(() => {
    const off = window.notch.events.on('redmine:summary-changed', () => void loadSummary())
    void window.notch.redmine.view({ open: true })
    void window.notch.redmine.refresh()
    return () => {
      off()
      void window.notch.redmine.view({ open: false })
    }
  }, [])

  // Every reading (a poll, a write, a status change) may carry a new list: ask again.
  useEffect(() => {
    if (status !== 'ok' && status !== 'offline') return
    let current = true
    void window.notch.redmine.issues().then((result) => {
      if (!current) return
      if (result.ok) setList(result.data)
      setListFailed(!result.ok)
    })
    return () => {
      current = false
    }
  }, [status, updatedAt, listAttempt])

  // A new session status: read the summary main has cached.
  useEffect(() => {
    if (status !== 'ok' && status !== 'offline') return
    void loadSummary()
  }, [status])

  // Without a session there is nothing to detail.
  const live = status === 'ok' || status === 'offline'
  useEffect(() => {
    if (!live) setOpenId(null)
  }, [live])

  useEffect(() => {
    if (!resting) return
    const timer = setTimeout(() => setResting(false), REFRESH_REST_MS)
    return () => clearTimeout(timer)
  }, [resting])

  // Opening the detail focuses it; closing it lands back on its row.
  useLayoutEffect(() => {
    const target = pendingFocus.current
    if (target === null) return
    pendingFocus.current = null
    if (target === 'detail') {
      detail.current?.focus()
      return
    }
    const row = issueRow(scroller.current, target)
    if (row) {
      row.focus({ preventScroll: true })
      row.scrollIntoView({ block: 'nearest' })
    }
  })

  // The tile that opened the view unmounts, or a focused row went away: keep focus in the panel
  // so Esc goes back to the row.
  useLayoutEffect(() => {
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    panel.current?.focus()
  })

  const refresh = () => {
    if (resting) return
    setResting(true)
    void window.notch.redmine.refresh()
  }

  const openDetail = (id: number) => {
    pendingFocus.current = 'detail'
    setOpenId(id)
  }

  const closeDetail = () => {
    pendingFocus.current = openId
    setOpenId(null)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (openId !== null) closeDetail()
      else void window.notch.notch.back()
      return
    }
    // The rows and the chart handle their own arrows (and mark the event handled).
    if (event.defaultPrevented || openId !== null) return
    // Home inside the search box moves its caret, not the focus.
    const typing = event.target instanceof HTMLInputElement
    if ((event.key === 'ArrowDown' || (event.key === 'Home' && !typing)) && !scroller.current?.contains(document.activeElement)) {
      const first = issueRows(scroller.current)[0]
      if (!first) return
      event.preventDefault()
      first.focus()
    }
  }

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape' || query === '') return
    // First Esc clears the search; the next one reaches the panel (back to the row).
    event.preventDefault()
    event.stopPropagation()
    setQuery('')
  }

  const offline = status === 'offline'
  const updated = offline && updatedAt !== null ? formatUpdated(new Date(updatedAt).toISOString(), now, language) : ''
  const body: 'loading' | Notice | 'list' =
    state === null || (live && list === null && !listFailed)
      ? 'loading'
      : status === 'unconfigured'
        ? 'unconfigured'
        : status === 'auth-error'
          ? 'auth'
          : list && list.issues.length > 0
            ? 'list'
            : list === null
              ? 'error'
              : 'empty'
  const issues = list ? list.issues.filter((issue) => matchesIssue(issue, query)) : []
  const opened = openId === null ? undefined : list?.issues.find((issue) => issue.id === openId)

  return (
    // Focusable (not tabbable): a click on a blank area keeps focus in the panel, so Esc reaches
    // the panel (back to the row) instead of NotchApp's window-level dismiss.
    <div
      ref={panel}
      style={integrationStyle(color)}
      role="region"
      aria-label={t('integration.redmine')}
      data-testid="redmine-panel"
      data-body={openId === null ? body : 'detail'}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex h-full flex-col gap-1.5 px-3 pb-2.5 pt-2 outline-none"
    >
      <header className="flex h-8 shrink-0 items-center gap-1">
        <button
          type="button"
          data-testid="redmine-back"
          onClick={() => (openId !== null ? closeDetail() : void window.notch.notch.back())}
          aria-label={t(openId !== null ? 'redmine.view.backToList' : 'redmine.view.back')}
          title={t(openId !== null ? 'redmine.view.backToList' : 'redmine.view.back')}
          className={headerIconButton}
        >
          <ArrowLeft size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <h2 className="ml-2 mr-2 shrink-0 text-body font-medium text-chalk">{t('integration.redmine')}</h2>
        {live && (
          <button
            type="button"
            data-testid="redmine-refresh"
            onClick={refresh}
            // aria-disabled, not disabled: a disabled button drops focus to <body>, where Esc would close the notch.
            aria-disabled={resting}
            aria-label={t('redmine.view.refresh')}
            title={t('redmine.view.refresh')}
            className={`${headerIconButton} ml-auto aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-graphite`}
          >
            <RefreshCw size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5">
        {openId !== null ? (
          <RedmineIssueDetail key={openId} ref={detail} id={openId} issue={opened} now={now} dimmed={offline} />
        ) : (
          <>
            {live && <RedmineSummary now={now} onRetry={refresh} retryResting={resting} />}
            {body === 'list' && list ? (
              <>
                <label className="relative flex h-7 shrink-0 items-center">
                  <span className="sr-only">{t('redmine.view.search')}</span>
                  <Search size={13} strokeWidth={1.8} aria-hidden="true" className="pointer-events-none absolute left-2 text-graphite" />
                  <input
                    type="search"
                    data-testid="redmine-search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={onSearchKeyDown}
                    placeholder={t('redmine.view.searchPlaceholder')}
                    spellCheck={false}
                    autoComplete="off"
                    className="field h-7 w-full pl-7 pr-2 text-small text-chalk placeholder:text-graphite [&::-webkit-search-cancel-button]:hidden"
                  />
                </label>
                <RedmineIssueList ref={scroller} issues={issues} truncated={list.truncated} dimmed={offline} onOpen={openDetail} />
              </>
            ) : body === 'loading' ? (
              <RedmineSkeleton />
            ) : (
              <RedmineStatus notice={body === 'list' ? 'empty' : body} onRetry={() => setListAttempt((n) => n + 1)} />
            )}
          </>
        )}
      </div>

      {offline && (
        <footer className="flex h-5 shrink-0 items-center px-1">
          <span data-testid="redmine-offline" className="min-w-0 truncate text-label text-graphite">
            {t('redmine.view.offline')}
            {updated && ` · ${updated}`}
          </span>
        </footer>
      )}
    </div>
  )
}
