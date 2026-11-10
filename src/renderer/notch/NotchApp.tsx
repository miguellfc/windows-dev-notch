import { EyeOff, SlidersHorizontal } from 'lucide-react'
import { AnimatePresence, MotionConfig, motion, type Transition } from 'motion/react'
import { useEffect, useState, type ReactNode } from 'react'
import { CAPSULE_SIZES, SHADOW_MARGIN, type VisibleMode } from '../../shared/notch/geometry'
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
import { TerminalView } from './TerminalView'

// One authored motion: the capsule morphs as a single object. Grow springs, shrink is quicker.
const GROW: Transition = { type: 'spring', stiffness: 380, damping: 32 }
const SHRINK: Transition = { duration: 0.18, ease: [0.16, 1, 0.3, 1] }
const LEVITATION = 'inset 0 1px 0 rgba(255,255,255,0.06), 0 18px 50px rgba(0,0,0,0.55)'
const LEVITATION_LOW = '0 2px 6px rgba(0,0,0,0.4)'

const area = (mode: VisibleMode) => CAPSULE_SIZES[mode].width * CAPSULE_SIZES[mode].height

interface ModeState {
  mode: NotchMode
  /** Whether the latest change enlarged the capsule; picks the grow or shrink motion. */
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
          : { mode, growing: area(mode) >= area(previous.lastVisible), lastVisible: mode },
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

export function NotchApp() {
  const { mode, growing } = useNotchMode()
  const settings = useSettings((state) => state.settings)

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

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex h-screen justify-center" style={{ paddingTop: SHADOW_MARGIN.top }}>
        <motion.div
          layout
          data-testid="notch-capsule"
          data-mode={mode}
          transition={growing ? GROW : SHRINK}
          onLayoutAnimationComplete={() => void window.notch.notch.settled()}
          onPointerEnter={() => void window.notch.notch.pointer({ inside: true })}
          onPointerLeave={() => void window.notch.notch.pointer({ inside: false })}
          onClick={expanded ? undefined : () => void window.notch.notch.request({ intent: 'expand' })}
          style={{
            width: size.width,
            height: size.height,
            borderRadius: expanded ? 24 : 999,
            boxShadow: mode === 'mini' ? LEVITATION_LOW : LEVITATION,
          }}
          className={`relative overflow-hidden border border-line text-chalk ${
            expanded ? 'bg-obsidian-dense' : 'cursor-pointer bg-obsidian'
          }`}
        >
          <AnimatePresence initial={false} mode="popLayout">
            <motion.div
              key={mode}
              layout="position"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              className="absolute inset-0"
            >
              <CapsuleContent mode={mode} settings={settings} />
            </motion.div>
          </AnimatePresence>
        </motion.div>
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
  if (mode === 'terminal') return <TerminalView />
  if (mode === 'alert') return <AlertCapsule />
  if (mode === 'permission') return <PermissionCard />
  if (mode === 'expanded') return <Panel time={time} date={date} shortcut={settings.shortcut} />

  return (
    <div className="flex h-full items-center justify-between gap-3 px-4">
      <span className="tabular shrink-0 whitespace-nowrap font-mono text-body font-medium">{time}</span>
      {mode === 'peek' ? (
        <span className="min-w-0 overflow-hidden">
          <Kbd accelerator={settings.shortcut} size="sm" />
        </span>
      ) : (
        <StatusDots fallback={<span className="truncate text-small text-graphite">{date}</span>} />
      )}
    </div>
  )
}

function Panel({ time, date, shortcut }: { time: string; date: string; shortcut: string }) {
  const t = useT()
  const action =
    'flex h-10 w-full cursor-pointer items-center gap-3 rounded-tile px-3 text-left text-body text-chalk transition-colors duration-150 hover:bg-veil-tile'
  return (
    <div className="flex h-full flex-col px-3 pb-3 pt-4">
      <header className="flex items-baseline justify-between px-2">
        <span className="tabular font-mono text-title font-medium">{time}</span>
        <span className="text-small text-graphite">{date}</span>
      </header>
      <div className="mt-3 flex items-start gap-2">
        <IntegrationRow />
        <SessionsSection />
      </div>
      <nav className="mt-3 flex flex-col gap-1" aria-label="Developer Notch">
        <button type="button" className={action} onClick={() => void window.notch.app.openControlCenter()}>
          <SlidersHorizontal size={16} strokeWidth={1.8} className="text-graphite" aria-hidden="true" />
          {t('notch.panel.controlCenter')}
        </button>
        <button type="button" className={action} onClick={() => void window.notch.app.hideNotch()}>
          <EyeOff size={16} strokeWidth={1.8} className="text-graphite" aria-hidden="true" />
          {t('notch.panel.hide')}
        </button>
      </nav>
      <footer className="mt-auto flex items-center justify-between px-2 text-label text-graphite">
        <span>{t('notch.panel.escHint')}</span>
        <Kbd accelerator={shortcut} size="sm" />
      </footer>
    </div>
  )
}
