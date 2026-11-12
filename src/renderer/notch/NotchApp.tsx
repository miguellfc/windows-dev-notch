import { EyeOff, SlidersHorizontal } from 'lucide-react'
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react'
import { Suspense, useEffect, useState, type ReactNode } from 'react'
import { CAPSULE_SIZES, compactWidthFor, expandedHeightFor, gmailSizeFor, growsWindow, SHADOW_MARGIN, type VisibleMode } from '../../shared/notch/geometry'
import { MAIL_ALERT_MS, PANEL_MODES, type NotchMode } from '../../shared/notch/state'
import type { Settings } from '../../shared/settings/schema'
import { useClaude } from '../shared/claude-store'
import { setMailAlert, setNewMail, setReading, useGmail } from '../shared/gmail-store'
import { keepsReader } from '../shared/gmail/format'
import { useSettings } from '../shared/settings-store'
import { useSystem } from '../shared/system-store'
import { useClock } from '../shared/use-clock'
import { locale, useLanguage, useT } from '../shared/use-t'
import { Kbd } from '../ui/Kbd'
import { AlertCapsule } from './claude/AlertCapsule'
import { PermissionCard } from './claude/PermissionCard'
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
import type { CapsuleView } from './system/capsule-latch'
import { CapsuleMail, CapsuleMetrics } from './system/CapsuleMetrics'
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
  const [state, setState] = useState<ModeState>({ mode: 'compact', growing: true, lastVisible: 'compact' })
  // Main sends the alert's kind before the mode that shows it; subscribe to it first as well.
  useEffect(() => window.notch.events.on('notch:mail-alert', setMailAlert), [])
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

export function NotchApp() {
  const { mode, growing } = useNotchMode()
  const settings = useSettings((state) => state.settings)
  const hasMail = useGmail((state) => state.mail.unread !== null)
  const compactWidth = useSystem((state) => compactWidthFor(state.capsule.view, hasMail))
  const sessionCount = useSessionCount()
  const reduceMotion = useReducedMotion() ?? false
  useReminderChime()
  useMailAlert(mode)
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

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex h-screen justify-center" style={{ paddingTop: SHADOW_MARGIN.top }}>
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
            onPointerEnter={() => void window.notch.notch.pointer({ inside: true })}
            onPointerLeave={() => void window.notch.notch.pointer({ inside: false })}
            onClick={expanded ? undefined : () => void window.notch.notch.request({ intent: 'expand' })}
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
              <motion.div
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
              </motion.div>
            </AnimatePresence>
          </motion.div>
        </div>
      </div>
    </MotionConfig>
  )
}

/** What the compact capsule shows besides time and date: the system metrics and the unread-mail count. */
interface CompactContent {
  view: CapsuleView | null
  unread: number | null
}

/**
 * The capsule content this copy was keyed for. A width change cross-fades two copies; the outgoing
 * one keeps the `compactWidth` it was rendered with (AnimatePresence freezes its props), so it
 * holds the last content of that width instead of re-rendering with the new sample.
 */
function useCompactContent(compactWidth: number): CompactContent {
  const view = useSystem((state) => state.capsule.view)
  const unread = useGmail((state) => state.mail.unread)
  const matches = compactWidthFor(view, unread !== null) === compactWidth
  const [kept, setKept] = useState<CompactContent>({ view, unread })
  if (matches && (kept.view !== view || kept.unread !== unread)) setKept({ view, unread })
  return matches ? { view, unread } : kept
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
  const { view, unread } = useCompactContent(compactWidth)

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
  if (mode === 'reminders') return <RemindersView />
  if (mode === 'system') return <SystemView />
  if (mode === 'notes') return <NotesView />
  if (mode === 'gmail') return <GmailView />
  if (mode === 'expanded') return <Panel time={time} date={date} shortcut={settings.shortcut} />

  const timeText = <span className="tabular shrink-0 whitespace-nowrap font-mono text-body font-medium">{time}</span>
  const dateOrDots = <StatusDots fallback={<span className="truncate text-small text-graphite-glass">{date}</span>} />

  if (mode === 'compact' && (view || unread !== null))
    return (
      <div className="flex h-full items-center justify-between gap-3 px-3.5">
        <span className="flex min-w-0 items-center gap-2.5">
          {timeText}
          {dateOrDots}
        </span>
        {/* Metrics, then the unread-mail block last; each slot exists only while its latch holds it. */}
        <span className="flex shrink-0 items-center gap-2.5">
          {view && <CapsuleMetrics view={view} />}
          {unread !== null && <CapsuleMail unread={unread} />}
        </span>
      </div>
    )

  return (
    <div className="flex h-full items-center justify-between gap-2 px-3.5">
      {timeText}
      {mode === 'peek' ? (
        <span className="min-w-0 overflow-hidden">
          <Kbd accelerator={settings.shortcut} size="sm" glass />
        </span>
      ) : (
        dateOrDots
      )}
    </div>
  )
}

/**
 * The alert capsule: the new-mail alert only when main says mail is the pending alert ("Correo
 * nuevo" when its payload is already spent, so the capsule is never empty); otherwise a Claude
 * permission or due reminders (AlertCapsule picks between them). Main decides, so a renderer store
 * that has not caught up yet never shows a mail alert in place of a permission or a reminder.
 */
function Alert() {
  const mailAlert = useGmail((store) => store.mailAlert)
  const newMail = useGmail((store) => store.newMail)
  return mailAlert ? <MailAlert mail={newMail} /> : <AlertCapsule />
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
