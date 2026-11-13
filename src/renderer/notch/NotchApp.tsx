import { EyeOff, SlidersHorizontal } from 'lucide-react'
import { AnimatePresence, MotionConfig, motion, useIsPresent, useReducedMotion, type HTMLMotionProps } from 'motion/react'
import { Suspense, useEffect, useState, type MouseEvent, type ReactNode, type Ref } from 'react'
import { CAPSULE_SIZES, capsuleTopFor, compactWidthFor, expandedHeightFor, gmailSizeFor, growsWindow, type VisibleMode } from '../../shared/notch/geometry'
import { MAIL_ALERT_MS, PANEL_MODES, REVIEW_ALERT_MS, type NotchMode } from '../../shared/notch/state'
import type { Settings } from '../../shared/settings/schema'
import { useClaude } from '../shared/claude-store'
import { setReviewAlert, setReviewAlertPayload, setReviewsTarget, useCodeReview } from '../shared/code-review-store'
import { setMailAlert, setNewMail, setReading, useGmail } from '../shared/gmail-store'
import { keepsReader } from '../shared/gmail/format'
import { useSettings } from '../shared/settings-store'
import { useSystem } from '../shared/system-store'
import { useClock } from '../shared/use-clock'
import { locale, useLanguage, useT } from '../shared/use-t'
import { Kbd } from '../ui/Kbd'
import { AlertCapsule } from './claude/AlertCapsule'
import { PermissionCard } from './claude/PermissionCard'
import { ReviewAlert } from './code-review/ReviewAlert'
import { ReviewsView } from './code-review/ReviewsView'
import { QuestionCard } from './claude/QuestionCard'
import { SessionsSection } from './claude/SessionsSection'
import { StatusDots } from './claude/StatusDots'
import { GmailView } from './gmail/GmailView'
import { MailAlert } from './gmail/MailAlert'
import { IntegrationRow } from './IntegrationRow'
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
import { reviewBlockCount, type CapsuleView, type ReviewBlocks } from './system/capsule-latch'
import { CapsuleMail, CapsuleMetrics, CapsuleReview } from './system/CapsuleMetrics'
import { SystemView } from './system/SystemView'
import { TerminalBoundary } from './TerminalBoundary'
import { LazyTerminalView } from './terminal-loader'

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

export function NotchApp() {
  const { mode, growing } = useNotchMode()
  const settings = useSettings((state) => state.settings)
  const hasMail = useGmail((state) => state.mail.unread !== null)
  const reviewBlocks = useCodeReview((state) => reviewBlockCount(state.blocks))
  const compactWidth = useSystem((state) => compactWidthFor(state.capsule.view, hasMail, reviewBlocks))
  const sessionCount = useSessionCount()
  const reduceMotion = useReducedMotion() ?? false
  useReminderChime()
  useMailAlert(mode)
  useReviewAlert(mode)
  const gmailReading = useGmail((state) => state.reading !== null)

  useEffect(() => {
    // Reduced motion snaps the morph, so no layout animation completes: let the window shrink
    // right after the commit instead of waiting for the controller's fallback timeout.
    if (reduceMotion && mode !== 'hidden') void window.notch.notch.settled()
  }, [reduceMotion, mode])

  useEffect(() => {
    // In the terminal, Esc belongs to PowerShell (it clears the line); leave with the
    // global shortcut, a click outside or the back button instead.
    if (mode === 'terminal') return
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
            layout
            data-testid="notch-capsule"
            data-mode={mode}
            // The radius morphs with the size (24 px panel ↔ half-height pill); never 999, which Motion
            // would turn into a percentage of the target box and flash an ellipse on close.
            animate={{ borderRadius: capsuleRadius(mode) }}
            transition={reduceMotion ? { ...morph, borderRadius: { duration: 0 } } : morph}
            onLayoutAnimationComplete={() => void window.notch.notch.settled()}
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
                <CapsuleContent mode={mode} settings={settings} compactWidth={size.width} />
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

/** What the compact capsule shows besides time and date: system metrics, unread mail and code reviews. */
interface CompactContent {
  view: CapsuleView | null
  unread: number | null
  reviews: ReviewBlocks
}

/**
 * The capsule content this copy was keyed for. A width change cross-fades two copies; the outgoing
 * one keeps the `compactWidth` it was rendered with (AnimatePresence freezes its props), so it
 * holds the last content of that width instead of re-rendering with the new sample.
 */
function useCompactContent(compactWidth: number): CompactContent {
  const view = useSystem((state) => state.capsule.view)
  const unread = useGmail((state) => state.mail.unread)
  const reviews = useCodeReview((state) => state.blocks)
  const matches = compactWidthFor(view, unread !== null, reviewBlockCount(reviews)) === compactWidth
  const [kept, setKept] = useState<CompactContent>({ view, unread, reviews })
  if (matches && (kept.view !== view || kept.unread !== unread || kept.reviews !== reviews)) setKept({ view, unread, reviews })
  return matches ? { view, unread, reviews } : kept
}

function CapsuleContent({
  mode,
  settings,
  compactWidth,
}: {
  mode: VisibleMode
  settings: Settings
  compactWidth: number
}): ReactNode {
  const now = useClock()
  const language = useLanguage()
  const time = new Intl.DateTimeFormat(locale(language), { hour: '2-digit', minute: '2-digit' }).format(now)
  const date = new Intl.DateTimeFormat(locale(language), { weekday: 'short', day: 'numeric', month: 'short' }).format(now)
  const { view, unread, reviews } = useCompactContent(compactWidth)
  const hasReviews = reviewBlockCount(reviews) > 0

  if (mode === 'mini') return null
  if (mode === 'terminal')
    return (
      // The chunk is preloaded on intent and read from disk, so the empty panel never shows for
      // more than a frame; a placeholder would flash instead. A failed load stays in this panel.
      <TerminalBoundary>
        <Suspense fallback={null}>
          <LazyTerminalView />
        </Suspense>
      </TerminalBoundary>
    )
  if (mode === 'alert') return <Alert />
  if (mode === 'permission') return <PermissionCard />
  if (mode === 'question') return <QuestionCard />
  if (mode === 'reminders') return <RemindersView />
  if (mode === 'system') return <SystemView />
  if (mode === 'notes') return <NotesView />
  if (mode === 'gmail') return <GmailView />
  if (mode === 'reviews') return <ReviewsView />
  if (mode === 'expanded') return <Panel time={time} date={date} shortcut={settings.shortcut} />

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

  const dateOrDots = <StatusDots fallback={dateText} />

  if (mode === 'compact' && (view || unread !== null || hasReviews))
    return (
      <div className="flex h-full items-center justify-between gap-3 px-3.5">
        <span className="flex min-w-0 items-center gap-2.5">
          {timeText}
          {dateOrDots}
        </span>
        {/* Metrics, the unread-mail block, then one block per code-review platform; each slot exists
            only while its latch holds it. */}
        <span className="flex shrink-0 items-center gap-2.5">
          {view && <CapsuleMetrics view={view} />}
          {unread !== null && <CapsuleMail unread={unread} />}
          {reviews.github.count !== null && <CapsuleReview platform="github" count={reviews.github.count} />}
          {reviews.gitlab.count !== null && <CapsuleReview platform="gitlab" count={reviews.gitlab.count} />}
        </span>
      </div>
    )

  // Compact with nothing besides time and date yet (no sample, no mail, no reviews).
  return (
    <div className="flex h-full items-center justify-between gap-2 px-3.5">
      {timeText}
      {dateOrDots}
    </div>
  )
}

/**
 * The alert capsule: the new-mail or first-review alert only when main says it is the pending alert
 * ("Correo nuevo" / "Revisado" when its payload is already spent, so the capsule is never empty); otherwise a Claude
 * permission or due reminders (AlertCapsule picks between them). Main decides, so a renderer store
 * that has not caught up yet never shows a mail alert in place of a permission or a reminder.
 */
function Alert() {
  const mailAlert = useGmail((store) => store.mailAlert)
  const newMail = useGmail((store) => store.newMail)
  const reviewAlert = useCodeReview((store) => store.reviewAlert)
  const review = useCodeReview((store) => store.alert)
  if (mailAlert) return <MailAlert mail={newMail} />
  return reviewAlert ? <ReviewAlert alert={review} /> : <AlertCapsule />
}

/** How many Claude sessions the home panel lists (its height follows). */
function useSessionCount(): number {
  return useClaude((store) => store.state?.sessions.length ?? 0)
}

function Panel({ time, date, shortcut }: { time: string; date: string; shortcut: string }) {
  const t = useT()
  const hasSessions = useSessionCount() > 0
  const action =
    'flex h-9 w-full cursor-pointer items-center gap-3 rounded-tile px-3 text-left text-body text-chalk transition-colors duration-150 hover:bg-veil-tile'
  return (
    <motion.div initial="hidden" animate="shown" variants={PANEL_STAGGER} className="flex h-full flex-col px-3 pb-3 pt-3.5">
      <motion.header variants={PANEL_ITEM} className="flex items-baseline justify-between px-2">
        <span className="tabular font-mono text-title font-medium">{time}</span>
        <span className="text-small text-graphite">{date}</span>
      </motion.header>
      <motion.div variants={PANEL_ITEM} className="mt-3 flex">
        <IntegrationRow />
      </motion.div>
      {hasSessions && (
        <motion.div variants={PANEL_ITEM} className="mt-3 flex">
          <SessionsSection />
        </motion.div>
      )}
      <motion.nav variants={PANEL_ITEM} className="mt-3 flex flex-col gap-1" aria-label="Developer Notch">
        <button type="button" className={action} onClick={() => void window.notch.app.openControlCenter()}>
          <SlidersHorizontal size={16} strokeWidth={1.8} className="text-graphite" aria-hidden="true" />
          {t('notch.panel.controlCenter')}
        </button>
        <button type="button" className={action} onClick={() => void window.notch.app.hideNotch()}>
          <EyeOff size={16} strokeWidth={1.8} className="text-graphite" aria-hidden="true" />
          {t('notch.panel.hide')}
        </button>
      </motion.nav>
      <motion.footer variants={PANEL_ITEM} className="mt-auto flex items-center justify-between px-2 text-label text-graphite">
        <span>{t('notch.panel.escHint')}</span>
        <Kbd accelerator={shortcut} size="sm" />
      </motion.footer>
    </motion.div>
  )
}
