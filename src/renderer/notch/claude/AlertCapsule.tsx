import type { CSSProperties } from 'react'
import { useClaude } from '../../shared/claude-store'
import { useT } from '../../shared/use-t'

/** The amber capsule: oldest pending permission (session and tool), plus how many more wait. */
export function AlertCapsule() {
  const t = useT()
  const pending = useClaude((store) => store.state?.pending)
  const oldest = pending?.[0]
  if (!pending || !oldest) return null

  return (
    <div
      data-testid="claude-alert"
      role="status"
      aria-label={`${t('claude.alert.label')}: ${oldest.sessionName}, ${oldest.toolName}`}
      className="flex h-full items-center gap-2.5 px-4"
    >
      <span className="status-dot pulse-wait" style={{ '--dot': 'var(--color-wait)' } as CSSProperties} />
      <span className="min-w-0 flex-1 truncate text-body text-chalk">
        <span className="font-medium">{oldest.sessionName}</span>
        <span className="text-graphite"> · </span>
        <span className="font-mono text-small text-graphite">{oldest.toolName}</span>
      </span>
      {pending.length > 1 && (
        <span className="tabular shrink-0 text-label font-medium text-wait">
          {t('claude.alert.more', { count: pending.length - 1 })}
        </span>
      )}
    </div>
  )
}
