import { Cog, EyeOff } from 'lucide-react'
import { AnimatePresence, MotionConfig, motion, useIsPresent, useReducedMotion, type HTMLMotionProps } from 'motion/react'
import { useCallback, useEffect, useMemo, useState, type MouseEvent, type ReactNode, type Ref } from 'react'
import { CAPSULE_SIZES, capsuleTopFor, compactWidthFor, expandedHeightFor, gmailSizeFor, growsWindow, type VisibleMode } from '../../shared/notch/geometry'
import { MAIL_ALERT_MS, PANEL_MODES, REDMINE_ALERT_MS, REVIEW_ALERT_MS, type NotchMode, type NotchView } from '../../shared/notch/state'
import type { IntegrationsSettings } from '../../shared/settings/schema'
import { useClaude } from '../shared/claude-store'
import { setRedmineAlert, setRedmineAlertPayload, useRedmine } from '../shared/redmine-store'
import { setReviewAlert, setReviewAlertPayload, setReviewsTarget, useCodeReview } from '../shared/code-review-store'
import { setMailAlert, setNewMail, setReading, useGmail } from '../shared/gmail-store'
import { keepsReader } from '../shared/gmail/format'
import { useSettings } from '../shared/settings-store'
import { useSystem } from '../shared/system-store'
import { useClock } from '../shared/use-clock'
import { locale, useLanguage, useT } from '../shared/use-t'
import { createCapsuleRectReporter } from './capsule-rect'
import { AlertCapsule } from './claude/AlertCapsule'
import { PermissionCard } from './claude/PermissionCard'
import { ReviewAlert } from './code-review/ReviewAlert'
import { ReviewsView } from './code-review/ReviewsView'
import { RedmineAlert } from './redmine/RedmineAlert'
import { RedmineView } from './redmine/RedmineView'
import { QuestionCard } from './claude/QuestionCard'
import { SessionsSection } from './claude/SessionsSection'
import { StatusDots } from './claude/StatusDots'
import { GmailView } from './gmail/GmailView'
import { MailAlert } from './gmail/MailAlert'
import { IntegrationRow } from './IntegrationRow'
import { alertAllowed, capsuleShows, panelSessionCount, viewAllowed, type AlertKind } from './integration-visibility'
import {
  capsuleRadius,
  CONTENT_EXIT,
  CONTENT_ANCHOR,
  CONTENT_ENTER,
  LEVITATION_DROP,
  LEVITATION_EDGE,
  LEVITATION_LOW_DROP,
  morphTransition,
  PANEL_ITEM,
  PANEL_STAGGER,
} from './motion'
import { NotesView } from './notes/NotesView'
import { playChime } from './reminders/chime'
import { RemindersView } from './reminders/RemindersView'
import { EMPTY_REVIEW_BLOCKS, capsuleSlots, reviewBlockCount, type CapsuleView, type ReviewBlocks } from './system/capsule-latch'
import { CapsuleMail, CapsuleMetrics, CapsuleRedmine, CapsuleReview } from './system/CapsuleMetrics'
import { SystemView } from './system/SystemView'

/** The integrations as last loaded (null before settings arrive: nothing is filtered yet). */
function currentIntegrations(): IntegrationsSettings | null {
  return useSettings.getState().settings?.integrations ?? null
}

interface ModeState {
  mode: NotchMode
  /** Whether the latest change grew the window (same rule as main); picks the grow or shrink motion. */
  growing: boolean
  lastVisible: VisibleMode
}

function useNotchMode(): ModeState {
  const [state, setState] = useState<ModeState>({ mode: 'peek', growing: true, lastVisible: 'peek' })
  // Main sends the alert's kind before the mode that shows it; subscribe to it first as well.
  useEffect(() => window.notch.events.on('notch:mail-alert', setMailAlert), [])
  useEffect(() => window.notch.events.on('notch:review-alert', setReviewAlert), [])
  useEffect(() => window.notch.events.on('notch:redmine-alert', setRedmineAlert), [])
  useEffect(() => {
    const apply = (mode: NotchMode) =>
      setState((previous) =>
        mode === 'hidden'
          ? { ...previous, mode }
          : { mode, growing: growsWindow(previous.lastVisible, mode), lastVisible: mode },
      )
    // Subscribe first; the initial read must not overwrite a newer pushed mode.
    let pushed = false
    const unsubscribe = window.notch.events.on('notch:mode-changed', (mode) => {
      pushed = true
      apply(mode)
    })
    void window.notch.notch.getMode().then((result) => {
      if (result.ok && !pushed) apply(result.data)
    })
    return unsubscribe
  }, [])
  return state
}

/**
 * Plays the chime for each new batch of due reminders if sound is on, whatever the capsule shows:
 * the alert shows over mini and hidden too.
 */
function useReminderChime(): void {
  useEffect(
    () =>
      window.notch.events.on('reminders:fired', () => {
        const integrations = currentIntegrations()
        if (integrations && !alertAllowed('reminder', integrations)) return
        const sound = useSettings.getState().settings?.reminders.sound ?? false
        if (sound) playChime()
      }),
    [],
  )
}

/**
 * Keeps the new-mail alert's payload for the alert capsule and plays the chime (sound on; also with
 * the capsule hidden, as the alert shows over it). The payload is always kept (main alone decides
 * whether the alert shows); it is spent once the capsule leaves the alert, and after the alert's 6 s
 * in any case. Also forgets the reader's message once the mode leaves the Gmail view (or the alert
 * whose click opens it).
 */
function useMailAlert(mode: NotchMode): void {
  useEffect(() => {
    if (mode !== 'alert' && mode !== 'hidden') setNewMail(null)
    if (!keepsReader(mode) && useGmail.getState().reading !== null) setReading(null)
  }, [mode])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = window.notch.events.on('gmail:new-mail', (mail) => {
      // A disabled Gmail never alerts: an answer already in flight when it was turned off is dropped.
      const integrations = currentIntegrations()
      if (integrations && !alertAllowed('mail', integrations)) return
      setNewMail(mail)
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        if (useGmail.getState().newMail === mail) setNewMail(null)
      }, MAIL_ALERT_MS)
      const sound = useSettings.getState().settings?.gmail.alerts.sound ?? false
      if (sound) playChime()
    })
    return () => {
      unsubscribe()
      if (timer !== null) clearTimeout(timer)
    }
  }, [])
}

/**
 * Forgets the alert's payload and the view target it set. A reviews view opened from the alert has
 * already read the target while rendering (before this effect runs), so it still lands on "Míos".
 */
function spendReviewAlert(): void {
  setReviewAlertPayload(null)
  setReviewsTarget(null)
}

/**
 * Keeps the first-review alert's payload for the alert capsule and plays the chime when that
 * platform's sound is on (also with the capsule hidden, as the alert shows over it). Like the mail
 * alert, the payload is spent once the capsule leaves the alert, and after the alert's 6 s.
 */
function useReviewAlert(mode: NotchMode): void {
  useEffect(() => {
    if (mode !== 'alert' && mode !== 'hidden') spendReviewAlert()
  }, [mode])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = window.notch.events.on('code-review:alert', (alert) => {
      const integrations = currentIntegrations()
      if (integrations && !alertAllowed(alert.platform === 'github' ? 'review-github' : 'review-gitlab', integrations)) return
      setReviewAlertPayload(alert)
      // Opening the panel while the alert shows (click, shortcut or tray) lands on that platform's "Míos".
      setReviewsTarget({ platform: alert.platform, section: 'mine' })
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        if (useCodeReview.getState().alert === alert) spendReviewAlert()
      }, REVIEW_ALERT_MS)
      const sound = useSettings.getState().settings?.codeReview.alerts[alert.platform].sound ?? false
      if (sound) playChime()
    })
    return () => {
      unsubscribe()
      if (timer !== null) clearTimeout(timer)
    }
  }, [])
}

/**
 * Keeps the end-of-day alert's payload for the alert capsule and plays the chime when its sound is
 * on (also with the capsule hidden, as the alert shows over it). Like the mail alert, the payload is
 * spent once the capsule leaves the alert, and after the alert's 6 s.
 */
function useRedmineAlert(mode: NotchMode): void {
  useEffect(() => {
    if (mode !== 'alert' && mode !== 'hidden') setRedmineAlertPayload(null)
  }, [mode])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = window.notch.events.on('redmine:alert', (alert) => {
      const integrations = currentIntegrations()
      if (integrations && !alertAllowed('redmine', integrations)) return
      setRedmineAlertPayload(alert)
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        if (useRedmine.getState().alert === alert) setRedmineAlertPayload(null)
      }, REDMINE_ALERT_MS)
      const sound = useSettings.getState().settings?.redmine.endOfDay.sound ?? false
      if (sound) playChime()
    })
    return () => {
      unsubscribe()
      if (timer !== null) clearTimeout(timer)
    }
  }, [])
}

/** Panel modes that show one view; the others (expanded, alert, capsules) are not views. */
const VIEW_MODES: ReadonlySet<NotchMode> = new Set<NotchMode>(['permission', 'question', 'reminders', 'system', 'notes', 'gmail', 'reviews', 'redmine'])

/** Turning an integration off while its view is open sends the panel back to home. */
function useCloseDisabledView(mode: NotchMode, integrations: IntegrationsSettings | null): void {
  const blocked = integrations !== null && VIEW_MODES.has(mode) && !viewAllowed(mode as NotchView, integrations)
  useEffect(() => {
    if (blocked) void window.notch.notch.back()
  }, [blocked])
}

/** The capsule blocks the latches hold, less those of integrations that are off or kept out of the capsule. */
interface CapsuleBlocks {
  unread: number | null
  reviews: ReviewBlocks
  hours: number | null
}

function useCapsuleBlocks(): CapsuleBlocks {
  const integrations = useSettings((state) => state.settings?.integrations ?? null)
  const unread = useGmail((state) => state.mail.unread)
  const latched = useCodeReview((state) => state.blocks)
  const hours = useRedmine((state) => state.block.hours)
  // Nothing shows until the settings load: a block of an integration that is off never flashes.
  const shows = (key: 'gmail' | 'github' | 'gitlab' | 'redmine') => integrations !== null && capsuleShows(key, integrations)
  const github = shows('github')
  const gitlab = shows('gitlab')
  // Memoized: useCompactContent compares the blocks by identity.
  const reviews = useMemo<ReviewBlocks>(
    () =>
      github && gitlab
        ? latched
        : { github: github ? latched.github : EMPTY_REVIEW_BLOCKS.github, gitlab: gitlab ? latched.gitlab : EMPTY_REVIEW_BLOCKS.gitlab },
    [latched, github, gitlab],
  )
  return { unread: shows('gmail') ? unread : null, reviews, hours: shows('redmine') ? hours : null }
}

/**
 * Reports the painted capsule's box to main whenever it resizes and when a layout animation ends
 * (only if it changed): Tauri lets clicks through everywhere else. Returns the capsule's ref and
 * the re-measure for `onLayoutAnimationComplete`.
 */
function useCapsuleRect() {
  const [reporter] = useState(() =>
    createCapsuleRectReporter<HTMLDivElement>((rect) => void window.notch.notch.capsuleRect(rect), ResizeObserver),
  )
  const ref = useCallback((element: HTMLDivElement | null) => (element ? reporter.observe(element) : undefined), [reporter])
  return { ref, refresh: () => reporter.refresh() }
}

export function NotchApp() {
  const { mode, growing } = useNotchMode()
  const settings = useSettings((state) => state.settings)
  const blocks = useCapsuleBlocks()
  const compactWidth = useSystem((state) =>
    compactWidthFor(capsuleSlots(state.capsule.view), blocks.unread !== null, reviewBlockCount(blocks.reviews), blocks.hours !== null),
  )
  const sessionCount = useSessionCount()
  const reduceMotion = useReducedMotion() ?? false
  useReminderChime()
  useMailAlert(mode)
  useReviewAlert(mode)
  useRedmineAlert(mode)
  useCloseDisabledView(mode, settings?.integrations ?? null)
  const gmailReading = useGmail((state) => state.reading !== null)
  const capsuleRect = useCapsuleRect()

  useEffect(() => {
    // Reduced motion snaps the morph, so no layout animation completes: let the window shrink
    // right after the commit instead of waiting for the controller's fallback timeout.
    if (reduceMotion && mode !== 'hidden') void window.notch.notch.settled()
  }, [reduceMotion, mode])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void window.notch.notch.request({ intent: 'dismiss' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode])

  if (mode === 'hidden' || !settings) return null

  // The compact capsule is only as wide as what it shows: it grows (one capsule morph) when the
  // first sample arrives and narrows back to time and date if the monitor stays unavailable.
  // The home panel is only as tall as what it lists: Claude sessions add their own line.
  const size =
    mode === 'compact'
      ? { ...CAPSULE_SIZES.compact, width: compactWidth }
      : mode === 'expanded'
        ? { ...CAPSULE_SIZES.expanded, height: expandedHeightFor(sessionCount) }
        : mode === 'gmail'
          ? gmailSizeFor(gmailReading)
          : CAPSULE_SIZES[mode]
  const expanded = PANEL_MODES.has(mode)
  const morph = morphTransition(mode, growing)
  // Left click: the pill goes back to compact (then peek once the pointer leaves); peek and compact
  // open the panel. Right click on peek or compact pins the pill at the top edge.
  const onClick = expanded
    ? undefined
    : () => void window.notch.notch.request({ intent: mode === 'mini' ? 'unpin-mini' : 'expand' })
  const onContextMenu =
    mode === 'compact' || mode === 'peek'
      ? (event: MouseEvent) => {
          event.preventDefault()
          void window.notch.notch.request({ intent: 'pin-mini' })
        }
      : undefined

  return (
    <MotionConfig reducedMotion="user">
      {/* The pinned mini sits flush against the top edge of the screen; every other capsule keeps its shadow room. */}
      {/* items-start: a stretched wrapper would reach the window's bottom (its 72 px shadow room). */}
      <div className="flex h-screen items-start justify-center" style={{ paddingTop: capsuleTopFor(mode) }}>
        {/* Unscaled wrapper: its drop shadow follows the morph without being stretched by it. */}
        <div style={{ filter: mode === 'mini' ? LEVITATION_LOW_DROP : LEVITATION_DROP }}>
          <motion.div
            ref={capsuleRect.ref}
            layout
            data-testid="notch-capsule"
            data-mode={mode}
            // The radius morphs with the size (26 px panel ↔ half-height pill); never 999, which Motion
            // would turn into a percentage of the target box and flash an ellipse on close.
            animate={{ borderRadius: capsuleRadius(mode) }}
            transition={reduceMotion ? { ...morph, borderRadius: { duration: 0 } } : morph}
            onLayoutAnimationComplete={() => {
              void window.notch.notch.settled()
              capsuleRect.refresh()
            }}
            // Hover and clicks belong to the painted capsule alone (its rounded corners clip hit-testing
            // too): never the shadow room around it, which stays click-through.
            onPointerEnter={() => void window.notch.notch.pointer({ inside: true })}
            onPointerLeave={() => void window.notch.notch.pointer({ inside: false })}
            onClick={onClick}
            onContextMenu={onContextMenu}
            style={{
              width: size.width,
              height: size.height,
              ...(mode === 'mini' ? {} : { boxShadow: LEVITATION_EDGE }),
            }}
            className={`relative overflow-hidden border border-line text-chalk ${
              expanded ? 'bg-obsidian-dense' : 'cursor-pointer bg-obsidian'
            }`}
          >
            <AnimatePresence initial={false} mode="popLayout">
              <PresenceLayer
                // A compact width change (first sample, battery, monitor lost) cross-fades its content
                // like a mode change; re-laid-out in place, the time would slide while the edge moves.
                key={mode === 'compact' ? `compact-${size.width}` : mode === 'expanded' ? `expanded-${size.height}` : mode}
                layout="position"
                // Project the content from the capsule's top-centre (its anchor at the screen edge), not its
                // top-left: during the morph it is clipped evenly on both sides, so the reveal reads as one
                // object growing from the top. At rest the boxes coincide, so nothing shifts.
                layoutAnchor={CONTENT_ANCHOR}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: CONTENT_ENTER }}
                exit={{ opacity: 0, transition: CONTENT_EXIT }}
                className="absolute inset-0"
              >
                <CapsuleContent mode={mode} compactWidth={size.width} />
              </PresenceLayer>
            </AnimatePresence>
          </motion.div>
        </div>
      </div>
    </MotionConfig>
  )
}

/**
 * One copy of the capsule content inside `AnimatePresence`. While it exits (popLayout keeps it in the
 * DOM until its fade ends, longer when the window is throttled) it is hidden from screen readers and
 * from focus/clicks, so only the present copy is reachable. Visually nothing changes.
 */
function PresenceLayer({ ref, ...props }: HTMLMotionProps<'div'> & { ref?: Ref<HTMLDivElement> }) {
  const isPresent = useIsPresent()
  return <motion.div ref={ref} {...props} aria-hidden={isPresent ? undefined : true} inert={!isPresent} />
}

/** What the compact capsule shows besides time and date: system metrics, unread mail, code reviews and Redmine hours. */
interface CompactContent {
  view: CapsuleView | null
  unread: number | null
  reviews: ReviewBlocks
  /** Hours logged in Redmine today; null while there is no block. */
  hours: number | null
}

/**
 * The capsule content this copy was keyed for. A width change cross-fades two copies; the outgoing
 * one keeps the `compactWidth` it was rendered with (AnimatePresence freezes its props), so it
 * holds the last content of that width instead of re-rendering with the new sample.
 */
function useCompactContent(compactWidth: number): CompactContent {
  const view = useSystem((state) => state.capsule.view)
  const { unread, reviews, hours } = useCapsuleBlocks()
  const matches = compactWidthFor(capsuleSlots(view), unread !== null, reviewBlockCount(reviews), hours !== null) === compactWidth
  const [kept, setKept] = useState<CompactContent>({ view, unread, reviews, hours })
  if (matches && (kept.view !== view || kept.unread !== unread || kept.reviews !== reviews || kept.hours !== hours)) {
    setKept({ view, unread, reviews, hours })
  }
  return matches ? { view, unread, reviews, hours } : kept
}

function CapsuleContent({
  mode,
  compactWidth,
}: {
  mode: VisibleMode
  compactWidth: number
}): ReactNode {
  const now = useClock()
  const language = useLanguage()
  const time = new Intl.DateTimeFormat(locale(language), { hour: '2-digit', minute: '2-digit' }).format(now)
  const date = new Intl.DateTimeFormat(locale(language), { weekday: 'short', day: 'numeric', month: 'short' }).format(now)
  const { view, unread, reviews, hours } = useCompactContent(compactWidth)
  const hasReviews = reviewBlockCount(reviews) > 0
  const claudeDots = useSettings((state) => (state.settings ? capsuleShows('claude', state.settings.integrations) : false))

  if (mode === 'mini') return null
  if (mode === 'alert') return <Alert />
  if (mode === 'permission') return <PermissionCard />
  if (mode === 'question') return <QuestionCard />
  if (mode === 'reminders') return <RemindersView />
  if (mode === 'system') return <SystemView />
  if (mode === 'notes') return <NotesView />
  if (mode === 'gmail') return <GmailView />
  if (mode === 'reviews') return <ReviewsView />
  if (mode === 'redmine') return <RedmineView />
  if (mode === 'expanded') return <Panel time={time} date={date} />

  const timeText = <span className="tabular shrink-0 whitespace-nowrap font-mono text-body font-medium">{time}</span>
  const dateText = <span className="truncate text-small text-graphite-glass">{date}</span>

  // Peek, the resting capsule: time and date only (hovering turns it into compact).
  if (mode === 'peek')
    return (
      <div className="flex h-full items-center justify-between gap-2 px-3.5">
        {timeText}
        {dateText}
      </div>
    )

  // Claude's dots take the date's place only while Claude shows in the capsule.
  const dateOrDots = claudeDots ? <StatusDots fallback={dateText} /> : dateText

  if (mode === 'compact' && (view || unread !== null || hasReviews || hours !== null))
    return (
      <div className="flex h-full items-center justify-between gap-3 px-3.5">
        <span className="flex min-w-0 items-center gap-2.5">
          {timeText}
          {dateOrDots}
        </span>
        {/* Metrics, the unread-mail block, one block per code-review platform, then the Redmine hours;
            each slot exists only while its latch holds it. */}
        <span className="flex shrink-0 items-center gap-2.5">
          {view && <CapsuleMetrics view={view} />}
          {unread !== null && <CapsuleMail unread={unread} />}
          {reviews.github.count !== null && <CapsuleReview platform="github" count={reviews.github.count} />}
          {reviews.gitlab.count !== null && <CapsuleReview platform="gitlab" count={reviews.gitlab.count} />}
          {hours !== null && <CapsuleRedmine hours={hours} />}
        </span>
      </div>
    )

  // Compact with nothing besides time and date yet (no sample, no mail, no reviews, no Redmine hours).
  return (
    <div className="flex h-full items-center justify-between gap-2 px-3.5">
      {timeText}
      {dateOrDots}
    </div>
  )
}

/**
 * The alert capsule: the new-mail, first-review or end-of-day Redmine alert only when main says it is the pending alert
 * ("Correo nuevo" / "Revisado" when its payload is already spent, so the capsule is never empty); otherwise a Claude
 * permission or due reminders (AlertCapsule picks between them). Main decides, so a renderer store
 * that has not caught up yet never shows a mail alert in place of a permission or a reminder.
 */
function Alert() {
  const mailAlert = useGmail((store) => store.mailAlert)
  const newMail = useGmail((store) => store.newMail)
  const reviewAlert = useCodeReview((store) => store.reviewAlert)
  const review = useCodeReview((store) => store.alert)
  const redmineAlert = useRedmine((store) => store.redmineAlert)
  const redmine = useRedmine((store) => store.alert)
  const integrations = useSettings((store) => store.settings?.integrations ?? null)
  const allowed = (kind: AlertKind) => integrations === null || alertAllowed(kind, integrations)
  // A spent review payload no longer says its platform: it shows while either platform is on.
  const reviewAllowed = review
    ? allowed(review.platform === 'github' ? 'review-github' : 'review-gitlab')
    : allowed('review-github') || allowed('review-gitlab')
  // An alert of a disabled integration never shows: the capsule falls through to the next one.
  if (mailAlert && allowed('mail')) return <MailAlert mail={newMail} />
  if (reviewAlert && reviewAllowed) return <ReviewAlert alert={review} />
  return redmineAlert && allowed('redmine') ? <RedmineAlert alert={redmine} /> : <AlertCapsule />
}

/** How many Claude sessions the home panel lists (its height follows): none while Claude is off. */
function useSessionCount(): number {
  const count = useClaude((store) => store.state?.sessions.length ?? 0)
  const integrations = useSettings((store) => store.settings?.integrations ?? null)
  return panelSessionCount(count, integrations)
}

const panelIconButton =
  'flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-control-sm bg-veil text-graphite transition-colors duration-150 hover:bg-veil-hover hover:text-chalk focus-visible:bg-veil-hover focus-visible:text-chalk'

function Panel({ time, date }: { time: string; date: string }) {
  const t = useT()
  const hasSessions = useSessionCount() > 0
  return (
    // Heights are exact (EXPANDED_HEIGHTS, 1 px capsule border): plain 14 + 28 + 12 + 60 + 12 = 126.
    // With sessions the card's own border and padding (1 + 4 top, 2 + 1 bottom) are absorbed by an
    // 8 px section gap and an 8 px bottom pad: 14 + 28 + 12 + 60 + 8 + (1 + 4 + 12 + 48 + 2 + 1) + 8 = 198.
    <motion.div
      initial="hidden"
      animate="shown"
      variants={PANEL_STAGGER}
      className={`flex h-full flex-col px-3 pt-3.5 ${hasSessions ? 'pb-2' : 'pb-3'}`}
    >
      <motion.header variants={PANEL_ITEM} className="flex items-center justify-between pl-2">
        <span className="digits text-digits-md">{time}</span>
        <span className="flex items-center gap-1">
          <span className="mr-1 text-small text-graphite">{date}</span>
          <button
            type="button"
            aria-label={t('notch.panel.controlCenter')}
            title={t('notch.panel.controlCenter')}
            className={panelIconButton}
            onClick={() => void window.notch.app.openControlCenter()}
          >
            <Cog size={16} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={t('notch.panel.hide')}
            title={t('notch.panel.hide')}
            className={panelIconButton}
            onClick={() => void window.notch.app.hideNotch()}
          >
            <EyeOff size={16} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </span>
      </motion.header>
      <motion.div variants={PANEL_ITEM} className="mt-3 flex">
        <IntegrationRow />
      </motion.div>
      {hasSessions && (
        <motion.div variants={PANEL_ITEM} className="mt-2 flex">
          <SessionsSection />
        </motion.div>
      )}
    </motion.div>
  )
}
