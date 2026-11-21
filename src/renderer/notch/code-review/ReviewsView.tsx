import { ArrowLeft, ExternalLink, GitPullRequest, KeyRound, RefreshCw, type LucideIcon } from 'lucide-react'
import { integrationStyle } from '../../shared/integration-color'
import { useSettings } from '../../shared/settings-store'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { localDate } from '../../../shared/code-review/contributions'
import type { Platform } from '../../../shared/code-review/schema'
import type { MessageKey } from '../../../shared/i18n/messages'
import { loadContributions, setReviewsTarget, setReviewsViewHeight, useCodeReview, type ReviewsTarget } from '../../shared/code-review-store'
import { contributionsPhase, graphSummaryText, placeholderGrid } from '../../shared/code-review/contributions-format'
import { configuredPlatforms, PLATFORM_NAMES, profileRow, reviewsBody, reviewsPlatform } from '../../shared/code-review/format'
import { formatUpdated } from '../../shared/gmail/format'
import { useClock } from '../../shared/use-clock'
import { useLanguage, useT } from '../../shared/use-t'
import { headerIconButton } from '../reminders/styles'
import { ContributionGraph } from './ContributionGraph'
import { ContributionSummary } from './ContributionSummary'

/** Main queries at most once per 5 s on a manual refresh; the button rests as long. */
const REFRESH_REST_MS = 5_000

type Notice = 'unconfigured' | 'auth'

const NOTICES: Readonly<Record<Notice, { icon: LucideIcon; title: MessageKey; action: boolean }>> = {
  unconfigured: { icon: GitPullRequest, title: 'codeReview.state.unconfigured', action: true },
  auth: { icon: KeyRound, title: 'codeReview.state.auth', action: true },
}

const button =
  'btn h-8 px-3'

/** Everything the view shows instead of the contributions, with a way to the Control Center page when it helps. */
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

/** Placeholder rows until the first state arrives; the pulse stops with reduced motion. */
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

/**
 * The month chart and the summary of one platform, side by side when they fit (else the summary
 * wraps below). Loading: the grey chart and "—"; a failed query keeps the last
 * data with "No se pudieron cargar las contribuciones · Reintentar".
 */
function Contributions({ platform, now, onRetry, retryResting }: { platform: Platform; now: Date; onRetry: () => void; retryResting: boolean }) {
  const t = useT()
  const language = useLanguage()
  const result = useCodeReview((store) => store.contributions[platform])
  const { phase, summary, error } = contributionsPhase(result)
  const today = localDate(now)
  const placeholder = summary ? null : placeholderGrid(now)
  const [dayText, setDayText] = useState<string | null>(null)
  return (
    <section
      aria-label={t('codeReview.contrib.region')}
      data-testid="contributions"
      data-phase={phase}
      aria-busy={phase === 'loading' || undefined}
      className="card flex shrink-0 flex-wrap gap-x-5 gap-y-2 px-3 py-2"
    >
      <ContributionGraph
        weeks={summary?.weeks ?? placeholder ?? []}
        month={summary?.month ?? today.slice(0, 7)}
        today={today}
        interactive={summary !== null}
        pulse={phase === 'loading'}
        {...(summary ? { description: graphSummaryText(summary, language) } : {})}
        onShowDay={setDayText}
      />
      <ContributionSummary
        platform={platform}
        summary={summary}
        error={error}
        loading={phase === 'loading'}
        now={now}
        onRetry={onRetry}
        retryResting={retryResting}
        dayText={summary ? dayText : null}
      />
    </section>
  )
}

/** The account (the server in front on GitLab) in mono, and the way to its page on the platform. */
function ProfileRow({ platform, label }: { platform: Platform; label: string }) {
  const t = useT()
  return (
    <div data-testid="reviews-profile" className="flex h-8 shrink-0 items-center gap-2 px-1">
      <span data-testid="reviews-account" title={label} className="min-w-0 flex-1 truncate font-mono text-label text-graphite">
        {label}
      </span>
      <button
        type="button"
        data-testid="reviews-open-profile"
        onClick={() => void window.notch.codeReview.openProfile({ platform })}
        className="btn h-6 shrink-0"
      >
        {t('codeReview.view.openProfile', { platform: PLATFORM_NAMES[platform] })}
        <ExternalLink size={12} strokeWidth={1.8} aria-hidden="true" className="text-graphite" />
      </button>
    </div>
  )
}

/**
 * The reviews mini tool for one platform, named in the header ("GitHub" / "GitLab", no tabs): the
 * tile (or the alert) that opened it picks the platform. It shows the contributions and, under them, the account with a button to its page.
 * Keyboard: Esc back to the integrations row. Opening the view asks main for a query now.
 */
export function ReviewsView() {
  const t = useT()
  const language = useLanguage()
  const now = useClock()
  const state = useCodeReview((store) => store.state)
  // Where the alert asked to land, read once: the store forgets it so the next opening is plain.
  const [target] = useState<ReviewsTarget | null>(() => useCodeReview.getState().target)
  const [resting, setResting] = useState(false)
  const panel = useRef<HTMLDivElement>(null)

  const integrations = useSettings((store) => store.settings?.integrations ?? null)
  // A platform turned off in Control Center is never shown: the view lands on the other one.
  const on = (candidate: Platform) => integrations === null || integrations[candidate].enabled
  const configured = configuredPlatforms(state).filter(on)
  const targetPlatform = target?.platform && on(target.platform) ? target.platform : null
  const platform = reviewsPlatform(targetPlatform ?? (on('github') ? null : 'gitlab'), configured)
  const color = integrations?.[platform].color ?? null
  const platformName = PLATFORM_NAMES[platform]
  const platformState = state?.[platform] ?? null
  const status = platformState?.status
  const updatedAt = platformState?.updatedAt ?? null
  const gitlabUrl = useSettings((store) => store.settings?.codeReview.gitlabUrl ?? '')

  useEffect(() => {
    setReviewsTarget(null)
    void window.notch.codeReview.refresh()
  }, [])

  // Contributions keep coming every 15 min while the view is open; the store follows each change.
  useEffect(() => {
    void window.notch.codeReview.view({ open: true })
    return () => void window.notch.codeReview.view({ open: false })
  }, [])

  // The platform's status changed: read its contributions (main answers from its cache).
  useEffect(() => {
    if (status !== 'ok' && status !== 'offline') return
    void loadContributions(platform)
  }, [platform, status])

  useEffect(() => {
    if (!resting) return
    const timer = setTimeout(() => setResting(false), REFRESH_REST_MS)
    return () => clearTimeout(timer)
  }, [resting])

  const body = state === null ? 'loading' : reviewsBody(platformState)
  const profile = platformState && body === 'contributions' ? profileRow(platformState, platform === 'gitlab' ? gitlabUrl : '') : null

  // The tile that opened the view unmounts, or the focused element went away: keep focus in the
  // panel so Esc goes back to the row.
  useLayoutEffect(() => {
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    panel.current?.focus()
  })

  // With contributions the view is only as tall as what it shows, and the capsule fits it (no empty
  // room under the account row); loading and notices keep the full panel and centre themselves in it.
  const fitted = body === 'contributions'
  useLayoutEffect(() => {
    const element = panel.current
    if (!fitted || !element) {
      setReviewsViewHeight(null)
      return
    }
    const report = () => setReviewsViewHeight(Math.ceil(element.getBoundingClientRect().height))
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    return () => {
      observer.disconnect()
      setReviewsViewHeight(null)
    }
  }, [fitted])

  const refresh = () => {
    if (resting) return
    setResting(true)
    void window.notch.codeReview.refresh()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      void window.notch.notch.back()
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
      style={color ? integrationStyle(color) : undefined}
      role="region"
      aria-label={platformName}
      data-testid="reviews-panel"
      data-platform={platform}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={`flex flex-col gap-1.5 px-3 pb-2.5 pt-2 outline-none ${fitted ? '' : 'h-full'}`}
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
        <h2 className="ml-2 mr-2 shrink-0 text-body font-medium text-chalk">{platformName}</h2>
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

      <div className={`flex min-h-0 flex-col gap-1.5 ${fitted ? '' : 'flex-1'}`}>
        {live && <Contributions platform={platform} now={now} onRetry={refresh} retryResting={resting} />}
        {profile && <ProfileRow platform={platform} label={profile.label} />}
        {body === 'loading' ? (
          <ReviewsSkeleton />
        ) : body === 'contributions' ? null : (
          <ReviewsStatus notice={body} />
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
