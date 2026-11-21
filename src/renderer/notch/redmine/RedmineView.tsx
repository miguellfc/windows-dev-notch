import { ArrowLeft, CloudOff, KeyRound, RefreshCw, Search, type LucideIcon } from 'lucide-react'
import { integrationStyle, useIntegration } from '../../shared/integration-color'
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type KeyboardEvent } from 'react'
import type { MessageKey } from '../../../shared/i18n/messages'
import type { RedmineIssue, RedmineIssueList as IssueList } from '../../../shared/redmine/schema'
import { REDMINE_SIZES } from '../../../shared/notch/geometry'
import { RedmineMark } from '../../shared/brand-icons'
import { formatUpdated } from '../../shared/gmail/format'
import { searchStep, settleSearch, truncatedSearchHint, type SearchResult, type SettledSearch } from '../../shared/redmine/search'
import { loadSummary, setRedmineSearching, setRedmineViewHeight, useRedmine } from '../../shared/redmine-store'
import { useClock } from '../../shared/use-clock'
import { useLanguage, useT } from '../../shared/use-t'
import { headerIconButton } from '../reminders/styles'
import { RedmineIssueDetail } from './RedmineIssueDetail'
import { issueRow, issueRows, RedmineIssueList } from './RedmineIssueList'
import { RedmineSummary } from './RedmineSummary'

/** Main queries at most once per 5 s on a manual refresh; the button rests as long. */
const REFRESH_REST_MS = 5_000

/** A number outside the list is asked of Redmine once the typing pauses, not for each digit. */
const LOOKUP_DELAY_MS = 300

type Notice = 'unconfigured' | 'auth' | 'error'

/** What each notice offers: Control Center (no session or a rejected key), Retry (the list could not be read), or nothing. */
const NOTICES: Readonly<Record<Notice, { icon: LucideIcon; title: MessageKey; action: 'control-center' | 'retry' | null }>> = {
  unconfigured: { icon: RedmineMark, title: 'redmine.state.unconfigured', action: 'control-center' },
  auth: { icon: KeyRound, title: 'redmine.state.auth', action: 'control-center' },
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
 * The Redmine mini tool. At rest, the hours summary (month chart and Hoy · Semana · Mes) and the
 * search box. While searching, the summary is one line and under the box come the matches as rows
 * (a single match, or a number Redmine finds outside the list, is a one-row list) or "no match".
 * A row opens the issue's detail, which takes the whole view (its own header "← #id subject", no
 * summary, no search box). Keyboard: Down goes from the box to the rows, arrows move between them
 * and Enter opens the detail (Enter in the box opens a lone row); Esc (or ←) closes the detail back
 * to its row with the search intact, then clears the search, then goes back to the integrations
 * row. Opening the view tells main (the month summary is queried only while it is open) and asks
 * for a query now; every new reading asks for the list again.
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
  // The row whose detail is open (a click or Enter on it); the rows stay behind it, search intact.
  const [pickedId, setPickedId] = useState<number | null>(null)
  // The open detail's latest read: a row found outside the list shows it once the detail closes.
  const [fresh, setFresh] = useState<RedmineIssue | null>(null)
  const [lookup, dispatchLookup] = useReducer(searchStep, { phase: 'idle' })
  const [lookupAttempt, setLookupAttempt] = useState(0)
  const [resting, setResting] = useState(false)
  const pendingFocus = useRef<number | 'detail' | 'search' | null>(null)
  const searchBox = useRef<HTMLInputElement>(null)
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

  // Without a session there is nothing to search or detail.
  const live = status === 'ok' || status === 'offline'
  useEffect(() => {
    if (live) return
    setQuery('')
    setPickedId(null)
  }, [live])

  // A query stays resolved until its text changes: a new list never replaces the open detail.
  const [settled, setSettled] = useState<SettledSearch | null>(null)
  const nextSettled = settleSearch(settled, query, list?.issues ?? null)
  if (nextSettled !== settled) setSettled(nextSettled)
  const result: SearchResult = nextSettled?.result ?? { kind: 'idle' }
  const lookupId = result.kind === 'lookup' ? result.id : null

  // Only the newest number counts (`searchStep`): a slower answer to an earlier one is dropped. A
  // number Redmine finds is read too, for its row.
  useEffect(() => {
    if (lookupId === null) {
      dispatchLookup({ type: 'clear' })
      return
    }
    dispatchLookup({ type: 'query', id: lookupId })
    const ask = async () => {
      const answer = await window.notch.redmine.findIssue({ id: lookupId })
      if (!answer.ok) return dispatchLookup({ type: 'failed', id: lookupId })
      if (!answer.data.found) return dispatchLookup({ type: 'answer', id: lookupId, issue: null })
      const read = await window.notch.redmine.issue({ id: lookupId })
      dispatchLookup(read.ok ? { type: 'answer', id: lookupId, issue: read.data } : { type: 'failed', id: lookupId })
    }
    const timer = setTimeout(() => void ask().catch(() => dispatchLookup({ type: 'failed', id: lookupId })), LOOKUP_DELAY_MS)
    return () => clearTimeout(timer)
  }, [lookupId, lookupAttempt])

  useEffect(() => {
    if (!resting) return
    const timer = setTimeout(() => setResting(false), REFRESH_REST_MS)
    return () => clearTimeout(timer)
  }, [resting])

  // Opening a row's detail focuses it; closing it lands back on its row; clearing the search lands
  // in the box.
  useLayoutEffect(() => {
    const target = pendingFocus.current
    if (target === null) return
    pendingFocus.current = null
    if (target === 'detail') {
      detail.current?.focus()
      return
    }
    if (target === 'search') {
      searchBox.current?.focus()
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

  const pickRow = (id: number) => {
    pendingFocus.current = 'detail'
    setPickedId(id)
  }

  const changeQuery = (next: string) => {
    setQuery(next)
    setPickedId(null)
    setFresh(null)
  }

  /** One step back: from the detail to its row (the search intact), then an empty search, then the integrations row. */
  const stepBack = () => {
    if (pickedId !== null) {
      pendingFocus.current = pickedId
      setPickedId(null)
    } else if (query !== '') {
      pendingFocus.current = 'search'
      changeQuery('')
    } else {
      void window.notch.notch.back()
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      stepBack()
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

  const offline = status === 'offline'
  const updated = offline && updatedAt !== null ? formatUpdated(new Date(updatedAt).toISOString(), now, language) : ''
  const body: 'loading' | Notice | 'list' =
    state === null || (live && list === null && !listFailed)
      ? 'loading'
      : status === 'unconfigured'
        ? 'unconfigured'
        : status === 'auth-error'
          ? 'auth'
          : list === null
            ? 'error'
            : 'list'
  // The answer about the number in the box; until it comes (or for another number) it is still searching.
  const answer = result.kind === 'lookup' && lookup.phase !== 'idle' && lookup.id === result.id ? lookup.phase : 'searching'
  // The rows under the box (none: "no match"); null while something else shows there.
  const rows: readonly RedmineIssue[] | null =
    body !== 'list'
      ? null
      : result.kind === 'many'
        ? result.issues
        : result.kind === 'one'
          ? [result.issue]
          : result.kind === 'none' || (result.kind === 'lookup' && answer === 'missing')
            ? []
            : result.kind === 'lookup' && lookup.phase === 'found' && lookup.id === result.id
              ? [fresh?.id === lookup.id ? fresh : lookup.issue]
              : null
  const openId = pickedId
  const opened = openId === null ? undefined : rows?.find((issue) => issue.id === openId)
  const typed = live && body !== 'error' && query.trim() !== ''
  // A list that failed to load needs the taller capsule for its notice under the full summary.
  const searching = typed || (live && body === 'error')

  // Before paint, so the capsule and its content change size together.
  useLayoutEffect(() => {
    setRedmineSearching(searching)
    return () => setRedmineSearching(false)
  }, [searching])

  // At rest, while the rows (or "no match") show and while an issue's detail is open, the view is
  // only as tall as what it shows and the capsule fits it (no empty room under the content), up to
  // the full size, where the list or the detail scrolls. Loading and notices keep the full size.
  const fitted = live && (openId !== null || !searching || rows !== null)
  // The view's ceiling while it fits: the capsule's full size less its 2 px border.
  const maxHeight = (searching ? REDMINE_SIZES.search : REDMINE_SIZES.rest).height - 2
  useLayoutEffect(() => {
    const element = panel.current
    if (!fitted || !element) {
      setRedmineViewHeight(null)
      return
    }
    const report = () => setRedmineViewHeight(Math.ceil(element.getBoundingClientRect().height))
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    return () => {
      observer.disconnect()
      setRedmineViewHeight(null)
    }
    // searching: report the new height in the same commit as the new size.
  }, [fitted, searching])

  return (
    // Focusable (not tabbable): a click on a blank area keeps focus in the panel, so Esc reaches
    // the panel (back to the row) instead of NotchApp's window-level dismiss.
    <div
      ref={panel}
      role="region"
      aria-label={t('integration.redmine')}
      data-testid="redmine-panel"
      data-body={openId === null ? body : 'detail'}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      // A max height of its own, not the capsule's: the capsule follows the view, so it can grow back.
      style={{ ...integrationStyle(color), ...(fitted ? { maxHeight } : {}) }}
      className={`flex flex-col gap-1.5 px-3 pb-2.5 pt-2 outline-none ${fitted ? '' : 'h-full'}`}
    >
      {openId !== null ? (
        <RedmineIssueDetail key={openId} ref={detail} id={openId} issue={opened} now={now} dimmed={offline} onBack={stepBack} onIssue={setFresh} />
      ) : (
        <>
          <header className="flex h-8 shrink-0 items-center gap-1">
            <button
              type="button"
              data-testid="redmine-back"
              onClick={stepBack}
              aria-label={t('redmine.view.back')}
              title={t('redmine.view.back')}
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

          <div className={`flex min-h-0 flex-col gap-1.5 ${fitted ? '' : 'flex-1'}`}>
            {live && <RedmineSummary now={now} onRetry={refresh} retryResting={resting} compact={typed} />}
            {live && body !== 'error' && (
              <label className="relative flex h-7 shrink-0 items-center">
                <span className="sr-only">{t('redmine.view.search')}</span>
                <Search size={13} strokeWidth={1.8} aria-hidden="true" className="pointer-events-none absolute left-2 text-graphite" />
                <input
                  ref={searchBox}
                  type="search"
                  data-testid="redmine-search"
                  value={query}
                  onChange={(event) => changeQuery(event.target.value)}
                  onKeyDown={(event) => {
                    // A lone row opens from the box too.
                    const [only] = rows ?? []
                    if (event.key !== 'Enter' || !only || rows?.length !== 1) return
                    event.preventDefault()
                    pickRow(only.id)
                  }}
                  placeholder={t('redmine.view.searchPlaceholder')}
                  spellCheck={false}
                  autoComplete="off"
                  className="field h-7 w-full pl-7 pr-2 text-small text-chalk placeholder:text-graphite [&::-webkit-search-cancel-button]:hidden"
                />
              </label>
            )}
            {body === 'loading' ? (
              (!live || typed) && <RedmineSkeleton />
            ) : body !== 'list' ? (
              <RedmineStatus notice={body} onRetry={() => setListAttempt((n) => n + 1)} />
            ) : rows !== null ? (
              <RedmineIssueList
                ref={scroller}
                issues={rows}
                more={result.kind === 'many' ? result.more : 0}
                dimmed={offline}
                truncatedHint={rows.length === 0 && truncatedSearchHint(query, result, list?.truncated ?? false)}
                onOpen={pickRow}
              />
            ) : result.kind === 'lookup' && answer === 'failed' ? (
              <RedmineStatus notice="error" onRetry={() => setLookupAttempt((n) => n + 1)} />
            ) : result.kind === 'lookup' ? (
              <RedmineSkeleton />
            ) : null}
          </div>
        </>
      )}

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
