import { Cog, EyeOff } from 'lucide-react'
import { AnimatePresence, MotionConfig, motion, useIsPresent, useReducedMotion, type HTMLMotionProps } from 'motion/react'
import { useCallback, useEffect, useMemo, useState, type MouseEvent, type ReactNode, type Ref } from 'react'
import { CAPSULE_SIZES, capsuleTopFor, compactWidthFor, gmailSizeFor, growsWindow, type VisibleMode } from '../../shared/notch/geometry'
import { MAIL_ALERT_MS, PANEL_MODES, REDMINE_ALERT_MS, REVIEW_ALERT_MS, type NotchMode, type NotchView } from '../../shared/notch/state'
import type { IntegrationsSettings } from '../../shared/settings/schema'
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
import { StatusDots, useClaudeDots } from './claude/StatusDots'
import { GmailView } from './gmail/GmailView'
import { MailAlert } from './gmail/MailAlert'
import { alertAllowed, capsuleShows, viewAllowed, type AlertKind } from './integration-visibility'
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
import { CardRow } from './panel/CardRow'
import { HelpLine } from './panel/HelpLine'
import { QuickAccess, useOpenFailure } from './panel/QuickAccess'
import { playChime } from './reminders/chime'
import { RemindersView } from './reminders/RemindersView'
import { EMPTY_REVIEW_BLOCKS, reviewBlockCount, type CapsuleView, type ReviewBlocks } from './system/capsule-latch'
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
 * already read the target while rendering (before this effect runs), so it still lands on that platform.
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
      // Opening the panel while the alert shows (click, shortcut or tray) lands on that platform.
      setReviewsTarget({ platform: alert.platform })
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
  /** Some Claude session has a dot (and Claude shows in the capsule). */
  claude: boolean
  unread: number | null
  reviews: ReviewBlocks
  hours: number | null
}

function useCapsuleBlocks(): CapsuleBlocks {
  const integrations = useSettings((state) => state.settings?.integrations ?? null)
  const unread = useGmail((state) => state.mail.unread)
  const latched = useCodeReview((state) => state.blocks)
  const hours = useRedmine((state) => state.block.hours)
  const dots = useClaudeDots().dots.length > 0
  // Nothing shows until the settings load: a block of an integration that is off never flashes.
  const shows = (key: 'claude' | 'gmail' | 'github' | 'gitlab' | 'redmine') => integrations !== null && capsuleShows(key, integrations)
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
  return { claude: shows('claude') && dots, unread: shows('gmail') ? unread : null, reviews, hours: shows('redmine') ? hours : null }
}

/** Width of the compact capsule for the system view (null: no sample) and the integration blocks it shows. */
function compactWidthOf(view: CapsuleView | null, blocks: CapsuleBlocks): number {
  return compactWidthFor({
    system: view && { battery: view.battery !== null },
    blocks: { claude: blocks.claude, mail: blocks.unread !== null, reviews: reviewBlockCount(blocks.reviews), redmine: blocks.hours !== null },
  })
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
  const compactWidth = useSystem((state) => compactWidthOf(state.capsule.view, blocks))
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
  const size =
    mode === 'compact'
      ? { ...CAPSULE_SIZES.compact, width: compactWidth }
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
                key={mode === 'compact' ? `compact-${size.width}` : mode}
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

/** What the compact capsule shows besides time and date: the integration blocks and the system view. */
interface CompactContent extends CapsuleBlocks {
  view: CapsuleView | null
}

/**
 * The capsule content this copy was keyed for. A width change cross-fades two copies; the outgoing
 * one keeps the `compactWidth` it was rendered with (AnimatePresence freezes its props), so it
 * holds the last content of that width instead of re-rendering with the new sample.
 */
function useCompactContent(compactWidth: number): CompactContent {
  const view = useSystem((state) => state.capsule.view)
  const blocks = useCapsuleBlocks()
  const { claude, unread, reviews, hours } = blocks
  const matches = compactWidthOf(view, blocks) === compactWidth
  const [kept, setKept] = useState<CompactContent>({ view, claude, unread, reviews, hours })
  if (matches && (kept.view !== view || kept.claude !== claude || kept.unread !== unread || kept.reviews !== reviews || kept.hours !== hours)) {
    setKept({ view, claude, unread, reviews, hours })
  }
  return matches ? { view, claude, unread, reviews, hours } : kept
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
  const { view, claude, unread, reviews, hours } = useCompactContent(compactWidth)
  const hasBlocks = claude || unread !== null || reviewBlockCount(reviews) > 0 || hours !== null

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

  // Left zone: time and date, always (the peek is this zone alone). It takes any spare width (the
  // widths are the worst case), so the other zones stay against the right edge.
  const left = (
    <span data-testid="capsule-zone-left" className="flex shrink-0 grow items-center gap-2.5">
      <span className="tabular shrink-0 whitespace-nowrap font-mono text-body font-medium">{time}</span>
      <span className="shrink-0 whitespace-nowrap text-small text-graphite-glass">{date}</span>
    </span>
  )

  if (mode === 'peek') return <div className="flex h-full items-center px-3.5">{left}</div>

  // Compact: time and date | the integration blocks | the system. A zone with nothing to show goes
  // with its divider. Every block and metric carries its 10 px gap before it (`*:ml-2.5`) and each
  // divider its 12 px before it, so the capsule measures as the sum of COMPACT_ZONE and CAPSULE_BLOCK.
  return (
    <div className="flex h-full items-center px-3.5">
      {left}
      {hasBlocks && (
        <>
          <ZoneDivider />
          {/* Claude, Gmail, GitHub, GitLab, then Redmine; each only while its latch holds it. */}
          <span data-testid="capsule-zone-blocks" className="flex shrink-0 items-center *:ml-2.5">
            {claude && <StatusDots />}
            {unread !== null && <CapsuleMail unread={unread} />}
            {reviews.github.count !== null && <CapsuleReview platform="github" count={reviews.github.count} />}
            {reviews.gitlab.count !== null && <CapsuleReview platform="gitlab" count={reviews.gitlab.count} />}
            {hours !== null && <CapsuleRedmine hours={hours} />}
          </span>
        </>
      )}
      {view && (
        <>
          <ZoneDivider />
          <span data-testid="capsule-zone-system" className="flex shrink-0 items-center">
            <CapsuleMetrics view={view} />
          </span>
        </>
      )}
    </div>
  )
}

/** The 1×14 px line between two zones of the compact capsule: 12 px before it, 2 px after (the next item adds its 10). */
function ZoneDivider() {
  return <span aria-hidden="true" data-testid="capsule-divider" className="ml-3 mr-0.5 h-3.5 w-px shrink-0 bg-line-strong" />
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

const panelIconButton =
  'flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-control-sm bg-veil text-graphite transition-colors duration-150 hover:bg-veil-hover hover:text-chalk focus-visible:bg-veil-hover focus-visible:text-chalk'

function Panel({ time, date }: { time: string; date: string }) {
  const t = useT()
  const { failed, reportFailure } = useOpenFailure()
  return (
    // Heights are exact (EXPANDED_SIZE, 1 px capsule border): 14 + 28 + 10 + 196 + 8 + 4 + 8 + 20 + 10 = 298.
    <motion.div data-notch-panel initial="hidden" animate="shown" variants={PANEL_STAGGER} className="flex h-full flex-col px-3 pb-2.5 pt-3.5">
      <motion.header variants={PANEL_ITEM} className="flex h-7 shrink-0 items-center justify-between">
        <span className="flex items-center gap-2.5">
          <span className="digits text-digits-md">{time}</span>
          <span aria-hidden="true" className="h-3.5 w-px bg-line-strong" />
          <span className="text-small text-graphite">{date}</span>
        </span>
        <span className="flex items-center gap-1">
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
      {/* 196 of cards, then 8 + 4 of page indicator: reserved even when the row has no pages. */}
      <motion.div variants={PANEL_ITEM} className="mt-2.5 flex h-[208px] shrink-0 gap-2.5">
        <QuickAccess onFailure={reportFailure} />
        <CardRow />
      </motion.div>
      <motion.div variants={PANEL_ITEM}>
        <HelpLine failed={failed} />
      </motion.div>
    </motion.div>
  )
}
