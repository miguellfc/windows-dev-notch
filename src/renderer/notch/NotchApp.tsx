import { EyeOff, SlidersHorizontal } from 'lucide-react'
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react'
import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { CAPSULE_SIZES, growsWindow, SHADOW_MARGIN, type VisibleMode } from '../../shared/notch/geometry'
import { PANEL_MODES, type NotchMode } from '../../shared/notch/state'
import type { Settings } from '../../shared/settings/schema'
import { useSettings } from '../shared/settings-store'
import { useClock } from '../shared/use-clock'
import { locale, useLanguage, useT } from '../shared/use-t'
import { Kbd } from '../ui/Kbd'
import { AlertCapsule } from './claude/AlertCapsule'
import { PermissionCard } from './claude/PermissionCard'
import { SessionsSection } from './claude/SessionsSection'
import { StatusDots } from './claude/StatusDots'
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
import { playChime } from './reminders/chime'
import { RemindersView } from './reminders/RemindersView'
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

/** Plays the chime for each new batch of due reminders, if sound is on and the capsule is shown. */
function useReminderChime(mode: NotchMode): void {
  const current = useRef(mode)
  useEffect(() => {
    current.current = mode
  }, [mode])
  useEffect(
    () =>
      window.notch.events.on('reminders:fired', () => {
        const sound = useSettings.getState().settings?.reminders.sound ?? false
        if (sound && current.current !== 'hidden') playChime()
      }),
    [],
  )
}

export function NotchApp() {
  const { mode, growing } = useNotchMode()
  const settings = useSettings((state) => state.settings)
  const reduceMotion = useReducedMotion() ?? false
  useReminderChime(mode)

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

  const size = CAPSULE_SIZES[mode]
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
                key={mode}
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
                <CapsuleContent mode={mode} settings={settings} />
              </motion.div>
            </AnimatePresence>
          </motion.div>
        </div>
      </div>
    </MotionConfig>
  )
}

function CapsuleContent({ mode, settings }: { mode: VisibleMode; settings: Settings }): ReactNode {
  const now = useClock()
  const language = useLanguage()
  const time = new Intl.DateTimeFormat(locale(language), { hour: '2-digit', minute: '2-digit' }).format(now)
  const date = new Intl.DateTimeFormat(locale(language), { weekday: 'short', day: 'numeric', month: 'short' }).format(now)

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
  if (mode === 'alert') return <AlertCapsule />
  if (mode === 'permission') return <PermissionCard />
  if (mode === 'reminders') return <RemindersView />
  if (mode === 'expanded') return <Panel time={time} date={date} shortcut={settings.shortcut} />

  return (
    <div className="flex h-full items-center justify-between gap-2 px-3.5">
      <span className="tabular shrink-0 whitespace-nowrap font-mono text-body font-medium">{time}</span>
      {mode === 'peek' ? (
        <span className="min-w-0 overflow-hidden">
          <Kbd accelerator={settings.shortcut} size="sm" glass />
        </span>
      ) : (
        <StatusDots fallback={<span className="truncate text-small text-graphite-glass">{date}</span>} />
      )}
    </div>
  )
}

function Panel({ time, date, shortcut }: { time: string; date: string; shortcut: string }) {
  const t = useT()
  const action =
    'flex h-9 w-full cursor-pointer items-center gap-3 rounded-tile px-3 text-left text-body text-chalk transition-colors duration-150 hover:bg-veil-tile'
  return (
    <motion.div initial="hidden" animate="shown" variants={PANEL_STAGGER} className="flex h-full flex-col px-3 pb-3 pt-3.5">
      <motion.header variants={PANEL_ITEM} className="flex items-baseline justify-between px-2">
        <span className="tabular font-mono text-title font-medium">{time}</span>
        <span className="text-small text-graphite">{date}</span>
      </motion.header>
      <motion.div variants={PANEL_ITEM} className="mt-3 flex items-start gap-2">
        <IntegrationRow />
        <SessionsSection />
      </motion.div>
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
