import { AlarmClock } from 'lucide-react'
import type { CSSProperties } from 'react'
import { useReminders } from '../../shared/reminders-store'
import { useT } from '../../shared/use-t'
import { integrationStyle, useIntegration } from '../../shared/integration-color'
import { attentionReminders } from '../../shared/reminders/format'

/**
 * The coral capsule for reminders: the oldest due/missed text, or "N reminders". Same layout and
 * type scale as the Claude alert: the pulsing coral "needs you" dot, the clock in the reminders' color, then chalk text.
 */
export function ReminderAlert() {
  const t = useT()
  const { color } = useIntegration('reminders')
  const reminders = useReminders((store) => store.reminders)
  if (!reminders) return null
  const attention = attentionReminders(reminders)
  const oldest = attention[0]
  if (!oldest) return null
  const text = attention.length === 1 ? oldest.text : t('reminders.alert.count', { count: attention.length })

  return (
    <div
      data-testid="reminder-alert"
      role="status"
      aria-label={`${t('reminders.alert.label')}: ${text}`}
      className="flex h-full items-center gap-2 px-3.5"
      style={integrationStyle(color)}
    >
      <span aria-hidden="true" className="status-dot pulse-wait" style={{ '--dot': 'var(--color-wait)' } as CSSProperties} />
      <AlarmClock size={13} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-[color:var(--int)]" />
      <span className="min-w-0 flex-1 truncate text-body font-semibold text-chalk">{text}</span>
    </div>
  )
}
