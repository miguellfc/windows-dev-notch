import { Bot } from 'lucide-react'
import type { CSSProperties } from 'react'
import type { PendingQuestionView } from '../../../shared/claude/types'
import { useClaude } from '../../shared/claude-store'
import { useQuestions } from '../../shared/questions-store'
import { useAttentionCount } from '../../shared/reminders-store'
import { useT } from '../../shared/use-t'
import { ReminderAlert } from '../reminders/ReminderAlert'
import { questionFirst } from './question-form'

/**
 * The amber capsule: the earliest pending Claude item, a permission (session and tool) or a question
 * ("Claude asks · project"), plus how many more Claude items wait. Claude wins when reminders are due
 * too; a small amber dot then says so. With nothing pending from Claude, the reminders alert shows.
 */
export function AlertCapsule() {
  const t = useT()
  const pending = useClaude((store) => store.state?.pending)
  const questions = useQuestions((store) => store.questions)
  const remindersDue = useAttentionCount()
  const permissions = pending ?? []
  const asked = questions ?? []
  const more = permissions.length + asked.length - 1
  const reminderDot = remindersDue > 0 && (
    <span
      data-testid="claude-alert-reminder-dot"
      role="img"
      aria-label={t('reminders.alert.alsoDue')}
      className="size-1.5 shrink-0 rounded-full bg-wait"
    />
  )
  const moreBadge = more > 0 && (
    <span className="tabular shrink-0 text-label font-medium text-wait">{t('claude.alert.more', { count: more })}</span>
  )

  if (questionFirst(permissions, asked)) {
    const question = asked.reduce<PendingQuestionView>((a, b) => (b.arrivedAt < a.arrivedAt ? b : a), asked[0]!)
    return (
      <div
        data-testid="claude-question-alert"
        role="status"
        aria-label={`${t('claude.alert.questionLabel')}: ${question.project}`}
        className="flex h-full items-center gap-2 px-3.5"
      >
        {/* Claude's icon (as in Control Center) in amber: Claude waits for the user. */}
        <Bot size={13} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-wait" />
        {/* Claude's texts are always plain text: React escapes them. */}
        <span className="min-w-0 flex-1 truncate text-body text-chalk">
          <span className="font-medium">{t('claude.alert.question')}</span>
          <span className="text-graphite-glass"> · </span>
          <span className="text-graphite-glass">{question.project}</span>
        </span>
        {moreBadge}
        {reminderDot}
      </div>
    )
  }

  const oldest = permissions[0]
  if (!oldest) return <ReminderAlert />

  return (
    <div
      data-testid="claude-alert"
      role="status"
      aria-label={`${t('claude.alert.label')}: ${oldest.sessionName}, ${oldest.toolName}`}
      className="flex h-full items-center gap-2 px-3.5"
    >
      <span className="status-dot pulse-wait" style={{ '--dot': 'var(--color-wait)' } as CSSProperties} />
      <span className="min-w-0 flex-1 truncate text-body text-chalk">
        <span className="font-medium">{oldest.sessionName}</span>
        <span className="text-graphite-glass"> · </span>
        <span className="font-mono text-small text-graphite-glass">{oldest.toolName}</span>
      </span>
      {moreBadge}
      {reminderDot}
    </div>
  )
}
