import type { CSSProperties } from 'react'
import { useClaude } from '../../shared/claude-store'
import { useAttentionCount } from '../../shared/reminders-store'
import { useT } from '../../shared/use-t'
import { ReminderAlert } from '../reminders/ReminderAlert'

/**
 * The amber capsule: oldest pending permission (session and tool), plus how many more wait.
 * Claude wins when both need attention; a small amber dot then says reminders are due too.
 * With no pending permission, it shows the reminders alert instead.
 */
export function AlertCapsule() {
  const t = useT()
  const pending = useClaude((store) => store.state?.pending)
  const remindersDue = useAttentionCount()
  const oldest = pending?.[0]
  if (!pending || !oldest) return <ReminderAlert />

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
      {remindersDue > 0 && (
        <span
          data-testid="claude-alert-reminder-dot"
          role="img"
          aria-label={t('reminders.alert.alsoDue')}
          className="size-1.5 shrink-0 rounded-full bg-wait"
        />
      )}
    </div>
  )
}
