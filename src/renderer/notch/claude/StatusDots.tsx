import { useEffect, useState, type CSSProperties } from 'react'
import { MAX_DOTS, nextDoneExpiry, summarizeDots, type DotStatus, type DotSummary } from '../../../shared/claude/view'
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

/** Widest "+N" the block can show: one digit, as wide as any other in the tabular mono font. */
const WIDEST_EXTRA = '+9'

/**
 * The Claude block of the compact capsule: its mark, then the sessions' dots and "+N". The parent
 * shows it only while some session has a dot; it always reserves 4 dots and "+9" so the capsule
 * width never follows the number of dots.
 */
export function StatusDots() {
  const t = useT()
  const { color } = useIntegration('claude')
  const { dots, extra, counts } = useClaudeDots()

  const parts = (['working', 'waiting', 'error', 'done'] as const)
    .filter((status) => counts[status] > 0)
    .map((status) => t(`claude.dots.${status}`, { count: counts[status] }))
  if (extra > 0) parts.push(t('claude.dots.more', { count: extra }))
  const label = `${t('claude.section.title')}: ${parts.join(', ')}`

  return (
    <span role="img" aria-label={label} data-testid="claude-dots" className="flex items-center gap-1" style={integrationStyle(color)}>
      <ClaudeMark size={12} strokeWidth={2} aria-hidden="true" className="shrink-0 text-[color:var(--int)]" />
      {/* The invisible widest content fixes the width; the real dots sit over it, from the left. */}
      <span className="grid" aria-hidden="true">
        <span className="invisible flex items-center gap-1.5 [grid-area:1/1]">
          {Array.from({ length: MAX_DOTS }, (_, index) => (
            // A status dot's 8 px box, without its class: `.status-dot` counts the sessions shown.
            <span key={index} className="size-2 shrink-0" />
          ))}
          <span className="tabular font-mono text-small font-medium">{WIDEST_EXTRA}</span>
        </span>
        <span className="flex items-center gap-1.5 [grid-area:1/1]">
          {dots.map((status, index) => (
            <span key={index} className="status-dot" style={{ '--dot': DOT_COLOR[status] } as CSSProperties} />
          ))}
          {extra > 0 && <span className="tabular font-mono text-small font-medium text-chalk">+{extra}</span>}
        </span>
      </span>
    </span>
  )
}
