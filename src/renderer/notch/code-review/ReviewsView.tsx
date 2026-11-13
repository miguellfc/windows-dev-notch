import { ArrowLeft, GitPullRequest, KeyRound, RefreshCw, type LucideIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { CodeReviewList, Platform } from '../../../shared/code-review/schema'
import type { MessageKey } from '../../../shared/i18n/messages'
import { setReviewsTarget, useCodeReview, type ReviewsTarget } from '../../shared/code-review-store'
import { configuredPlatforms, PLATFORM_NAMES, reviewsBody } from '../../shared/code-review/format'
import { formatUpdated } from '../../shared/gmail/format'
import { useClock } from '../../shared/use-clock'
import { useLanguage, useT } from '../../shared/use-t'
import { Segmented } from '../../ui/Segmented'
import { headerIconButton } from '../reminders/styles'
import { firstRowOf, ReviewList, reviewRows } from './ReviewList'

/** Main queries at most once per 5 s on a manual refresh; the button rests as long. */
const REFRESH_REST_MS = 5_000

type Notice = 'unconfigured' | 'auth' | 'empty'

const PANEL_ID = 'reviews-tabpanel'
const tabId = (platform: Platform): string => `reviews-tab-${platform}`

const NOTICES: Readonly<Record<Notice, { icon: LucideIcon; title: MessageKey; action: boolean }>> = {
  unconfigured: { icon: GitPullRequest, title: 'codeReview.state.unconfigured', action: true },
  auth: { icon: KeyRound, title: 'codeReview.state.auth', action: true },
  empty: { icon: GitPullRequest, title: 'codeReview.state.empty', action: false },
}

const button =
  'flex h-8 cursor-pointer items-center rounded-control border border-line bg-veil-tile px-3 text-small font-medium text-chalk transition-colors duration-150 hover:bg-veil-hover'

/** Everything the view shows instead of the lists, with a way to the Control Center page when it helps. */
function ReviewsStatus({ notice }: { notice: Notice }) {
  const t = useT()
  const { icon: Icon, title, action } = NOTICES[notice]
  return (
    <div role="status" data-testid="reviews-status" data-notice={notice} className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 pb-4 text-center">
      <Icon size={20} strokeWidth={1.8} aria-hidden="true" className="text-graphite" />
      <p className="text-body text-chalk">{t(title)}</p>
      {action && (
        <button
          type="button"
          data-testid="reviews-open-control-center"
          onClick={() => void window.notch.app.openControlCenter({ page: 'code-review' })}
          className={`${button} mt-1`}
        >
          {t('codeReview.state.openControlCenter')}
        </button>
      )}
    </div>
  )
}

/** Placeholder rows while the first lists load; the pulse stops with reduced motion. */
function ReviewsSkeleton() {
  const t = useT()
  return (
    <div data-testid="reviews-loading" aria-busy="true" className="-mx-1 flex min-h-0 flex-1 flex-col overflow-hidden px-1 pt-7">
      <p role="status" className="sr-only">
        {t('codeReview.state.loading')}
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

/** The lists last received per platform (kept while switching tabs) and the update they answer. */
type Lists = Partial<Record<Platform, CodeReviewList>>

/**
 * The "Revisiones" mini tool: tabs for the configured platforms, then "Por revisar" and "Míos".
 * Keyboard: arrows between rows, ←/→ between tabs, Enter opens, Esc back to the integrations row.
 * Opening the view asks main for a query now; every new reading asks for the lists again.
 */
export function ReviewsView() {
  const t = useT()
  const language = useLanguage()
  const now = useClock()
  const state = useCodeReview((store) => store.state)
  // Where the alert asked to land, read once: the store forgets it so the next opening is plain.
  const [target] = useState<ReviewsTarget | null>(() => useCodeReview.getState().target)
  const [chosen, setChosen] = useState<Platform | null>(target?.platform ?? null)
  const [lists, setLists] = useState<Lists>({})
  const [resting, setResting] = useState(false)
  const pendingFocus = useRef<ReviewsTarget['section'] | null>(target?.section ?? null)
  const panel = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)

  const configured = configuredPlatforms(state)
  const platform = chosen !== null && configured.includes(chosen) ? chosen : (configured[0] ?? null)
  const platformState = platform === null ? null : (state?.[platform] ?? null)
  const status = platformState?.status
  const updatedAt = platformState?.updatedAt ?? null

  useEffect(() => {
    setReviewsTarget(null)
    void window.notch.codeReview.refresh()
  }, [])

  // Every reading of this platform (a poll, a status change) may carry new lists: ask again.
  useEffect(() => {
    if (platform === null || (status !== 'ok' && status !== 'offline')) return
    let current = true
    void window.notch.codeReview.list({ platform }).then((result) => {
      if (current && result.ok) setLists((previous) => ({ ...previous, [platform]: result.data }))
    })
    return () => {
      current = false
    }
  }, [platform, status, updatedAt])

  useEffect(() => {
    if (!resting) return
    const timer = setTimeout(() => setResting(false), REFRESH_REST_MS)
    return () => clearTimeout(timer)
  }, [resting])

  const list = platform === null ? null : (lists[platform] ?? null)
  const body = state === null ? 'loading' : platform === null ? 'unconfigured' : reviewsBody(platformState, list)

  // The alert's click lands on the first row of "Míos" once its list is shown.
  useLayoutEffect(() => {
    const section = pendingFocus.current
    if (section === null || body !== 'list') return
    pendingFocus.current = null
    const row = firstRowOf(scroller.current, section)
    if (row) {
      row.focus({ preventScroll: true })
      row.scrollIntoView({ block: 'nearest' })
      row.closest('section')?.scrollIntoView({ block: 'start' })
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
    void window.notch.codeReview.refresh()
  }

  const open = (id: string) => {
    if (platform !== null) void window.notch.codeReview.open({ platform, id })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      void window.notch.notch.back()
      return
    }
    // The tabs handle their own arrows (and mark the event handled).
    if (event.defaultPrevented) return
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && platform !== null && configured.length > 1) {
      event.preventDefault()
      const index = configured.indexOf(platform)
      const next = configured[(index + (event.key === 'ArrowRight' ? 1 : configured.length - 1)) % configured.length]
      if (next) setChosen(next)
      return
    }
    if ((event.key === 'ArrowDown' || event.key === 'Home') && !scroller.current?.contains(document.activeElement)) {
      const first = reviewRows(scroller.current)[0]
      if (!first) return
      event.preventDefault()
      first.focus()
    }
  }

  const offline = status === 'offline'
  const live = status === 'ok' || offline
  const updated = offline ? formatUpdated(updatedAt, now, language) : ''

  return (
    // Focusable (not tabbable): a click on a blank area keeps focus in the panel, so Esc reaches
    // the panel (back to the row) instead of NotchApp's window-level dismiss.
    <div
      ref={panel}
      role="region"
      aria-label={t('integration.reviews')}
      data-testid="reviews-panel"
      data-platform={platform ?? undefined}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex h-full flex-col gap-1.5 px-3 pb-2.5 pt-2 outline-none"
    >
      <header className="flex h-8 shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => void window.notch.notch.back()}
          aria-label={t('codeReview.view.back')}
          title={t('codeReview.view.back')}
          className={headerIconButton}
        >
          <ArrowLeft size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <h2 className="ml-2 mr-2 shrink-0 text-body font-medium text-chalk">{t('integration.reviews')}</h2>
        {platform !== null && (
          <Segmented
            label={t('codeReview.view.platforms')}
            value={platform}
            options={configured.map((value) => ({ value, label: PLATFORM_NAMES[value] }))}
            onChange={setChosen}
            tabs={{ panelId: PANEL_ID, tabId }}
          />
        )}
        {live && (
          <button
            type="button"
            data-testid="reviews-refresh"
            onClick={refresh}
            // aria-disabled, not disabled: a disabled button drops focus to <body>, where Esc would close the notch.
            aria-disabled={resting}
            aria-label={t('codeReview.view.refresh')}
            title={t('codeReview.view.refresh')}
            className={`${headerIconButton} ml-auto aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-graphite`}
          >
            <RefreshCw size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        )}
      </header>

      {/* The selected platform's content; without any configured platform there are no tabs. */}
      <div
        {...(platform === null ? {} : { role: 'tabpanel', id: PANEL_ID, 'aria-labelledby': tabId(platform) })}
        className="flex min-h-0 flex-1 flex-col"
      >
        {body === 'loading' ? (
          <ReviewsSkeleton />
        ) : body === 'list' && list ? (
          <ReviewList ref={scroller} list={list} dimmed={offline} onOpen={open} />
        ) : (
          <ReviewsStatus notice={body === 'list' ? 'empty' : body} />
        )}
      </div>

      {offline && (
        <footer className="flex h-5 shrink-0 items-center px-1">
          <span data-testid="reviews-offline" className="min-w-0 truncate text-label text-graphite">
            {t('codeReview.view.offline')}
            {updated && ` · ${updated}`}
          </span>
        </footer>
      )}
    </div>
  )
}
