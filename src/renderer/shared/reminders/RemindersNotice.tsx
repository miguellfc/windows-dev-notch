import { TriangleAlert } from 'lucide-react'
import { useReminders } from '../reminders-store'
import { useT } from '../use-t'

/** Why the list may be incomplete: the file was moved aside, or this session cannot save. */
export function NoticeBanner() {
  const t = useT()
  const notice = useReminders((store) => store.notice)
  if (!notice) return null
  return (
    <p
      role="status"
      data-testid="reminders-notice"
      className="flex items-center gap-2 rounded-tile border border-line bg-veil px-2.5 py-1.5 text-small text-graphite"
    >
      <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-wait" />
      <span className="min-w-0">{t(notice === 'quarantined' ? 'reminders.notice.quarantined' : 'reminders.notice.readOnly')}</span>
    </p>
  )
}
