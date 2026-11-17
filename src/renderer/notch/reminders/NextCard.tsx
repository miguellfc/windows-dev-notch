import { useT, useLanguage } from '../../shared/use-t'
import { formatTime } from '../../shared/reminders/format'
import type { Reminder } from '../../../shared/reminders/schema'

/**
 * "Próximo": the time of the next pending reminder in pixel digits, with its text. Rendered above
 * the list only when something is pending. The text is always plain text.
 */
export function NextCard({ reminder }: { reminder: Reminder }) {
  const t = useT()
  const language = useLanguage()
  return (
    <div data-testid="reminders-next" className="card mb-2 flex shrink-0 items-center gap-3 px-3.5 py-2">
      <span className="digits text-digits-lg shrink-0 whitespace-nowrap text-chalk">
        {formatTime(new Date(reminder.dueAt), language)}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-caps font-medium uppercase text-graphite">{t('reminders.next.label')}</span>
        <span className="truncate text-body text-chalk">{reminder.text}</span>
      </span>
    </div>
  )
}
