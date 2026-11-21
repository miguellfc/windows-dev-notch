import { useAttentionCount, useReminders } from '../../../shared/reminders-store'
import { formatDueDay, formatTime, nextReminder } from '../../../shared/reminders/format'
import { useClock } from '../../../shared/use-clock'
import { useLanguage, useT } from '../../../shared/use-t'
import { CardNotice } from './CardNotice'

/** The next reminder and, in coral, how many are overdue. */
export function RemindersCard() {
  const t = useT()
  const language = useLanguage()
  const now = useClock()
  const reminders = useReminders((store) => store.reminders)
  const overdue = useAttentionCount()
  if (reminders === null) return <CardNotice text={t('panel.card.loading')} />
  const next = nextReminder(reminders)
  if (next === null && overdue === 0) return <CardNotice text={t('reminders.list.empty')} />
  const due = next ? new Date(next.dueAt) : null
  const day = due ? formatDueDay(due, now, language) : null
  return (
    <div className={`mt-2 flex min-h-0 flex-1 flex-col overflow-hidden ${next ? '' : 'justify-center'}`}>
      {next && due && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col justify-center gap-1">
          {day && <p className="truncate text-label text-graphite">{day}</p>}
          <p className="digits whitespace-nowrap text-digits-md text-chalk">{formatTime(due, language)}</p>
          <p className="truncate text-small text-chalk">{next.text}</p>
        </div>
      )}
      {overdue > 0 && (
        <p className="truncate text-small font-medium text-wait">
          {overdue === 1 ? t('panel.card.overdueOne') : t('panel.card.overdue', { count: overdue })}
        </p>
      )}
    </div>
  )
}
