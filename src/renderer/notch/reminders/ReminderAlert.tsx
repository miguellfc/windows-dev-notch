import { AlarmClock } from 'lucide-react'
import { useReminders } from '../../shared/reminders-store'
import { useT } from '../../shared/use-t'
import { attentionReminders } from '../../shared/reminders/format'

/**
 * The amber capsule for reminders: the oldest due/missed text, or "N reminders". Same layout and
 * type scale as the Claude alert: an amber 13 px marker, then chalk text.
 */
export function ReminderAlert() {
  const t = useT()
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
      className="flex h-full items-center gap-2.5 px-4"
    >
      <AlarmClock size={13} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-wait" />
      <span className="min-w-0 flex-1 truncate text-body font-medium text-chalk">{text}</span>
    </div>
  )
}
