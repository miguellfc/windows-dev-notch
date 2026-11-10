import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { nextDoneExpiry, summarizeDots, type DotStatus } from '../../../shared/claude/view'
import { useClaude } from '../../shared/claude-store'
import { useT } from '../../shared/use-t'

export const DOT_COLOR: Readonly<Record<DotStatus | 'idle', string>> = {
  working: 'var(--color-ice)',
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

/** Compact-capsule summary of Claude sessions; renders the fallback when no session has a dot. */
export function StatusDots({ fallback = null }: { fallback?: ReactNode }) {
  const t = useT()
  const sessions = useClaude((store) => store.state?.sessions)
  const now = useNowUntilDoneExpires()
  if (!sessions) return fallback
  const { dots, extra, counts } = summarizeDots(sessions, now)
  if (dots.length === 0) return fallback

  const parts = (['working', 'waiting', 'error', 'done'] as const)
    .filter((status) => counts[status] > 0)
    .map((status) => t(`claude.dots.${status}`, { count: counts[status] }))
  if (extra > 0) parts.push(t('claude.dots.more', { count: extra }))
  const label = `${t('claude.section.title')}: ${parts.join(', ')}`

  return (
    <span role="img" aria-label={label} data-testid="claude-dots" className="flex items-center gap-1.5">
      {dots.map((status, index) => (
        <span key={index} className="status-dot" style={{ '--dot': DOT_COLOR[status] } as CSSProperties} />
      ))}
      {extra > 0 && <span className="tabular text-label font-medium text-graphite">+{extra}</span>}
    </span>
  )
}
