import { useEffect, useState } from 'react'
import { nextDoneExpiry, summarizeDots, type DotStatus, type DotSummary } from '../../../shared/claude/view'
import { ClaudeMark } from '../../shared/brand-icons'
import { useClaude } from '../../shared/claude-store'
import { integrationStyle, useIntegration } from '../../shared/integration-color'
import { useT } from '../../shared/use-t'

export const DOT_COLOR: Readonly<Record<DotStatus | 'idle', string>> = {
  working: 'var(--color-select)',
  waiting: 'var(--color-wait)',
  done: 'var(--color-ok)',
  error: 'var(--color-fail)',
  idle: 'var(--color-graphite)',
}

/** Re-renders at each visible done dot's expiry; re-arms for the next one after every tick. */
function useNowUntilDoneExpires(): number {
  const sessions = useClaude((store) => store.state?.sessions)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!sessions) return
    const remaining = nextDoneExpiry(sessions, Date.now())
    if (remaining === null) return
    const timer = setTimeout(() => setTick((value) => value + 1), remaining + 20)
    return () => clearTimeout(timer)
  }, [sessions, tick])
  return Date.now()
}

const NO_DOTS: DotSummary = { dots: [], extra: 0, counts: { working: 0, waiting: 0, done: 0, error: 0 } }

/** The Claude sessions' dots right now (re-rendered when a done dot turns off). */
export function useClaudeDots(): DotSummary {
  const sessions = useClaude((store) => store.state?.sessions)
  const now = useNowUntilDoneExpires()
  return sessions ? summarizeDots(sessions, now) : NO_DOTS
}

/**
 * The Claude block of the compact capsule and the peek: its mark alone, in the integration color.
 * The parent shows it only while some session has a dot (working, waiting, error, or done a moment
 * ago); the accessible label still says how many sessions are in each state.
 */
export function StatusDots() {
  const t = useT()
  const { color } = useIntegration('claude')
  const { counts } = useClaudeDots()

  const parts = (['working', 'waiting', 'error', 'done'] as const)
    .filter((status) => counts[status] > 0)
    .map((status) => t(`claude.dots.${status}`, { count: counts[status] }))
  const label = `${t('claude.section.title')}: ${parts.join(', ')}`

  return (
    <span role="img" aria-label={label} data-testid="claude-dots" className="flex items-center" style={integrationStyle(color)}>
      <ClaudeMark size={12} strokeWidth={2} aria-hidden="true" className="shrink-0 text-[color:var(--int)]" />
    </span>
  )
}
