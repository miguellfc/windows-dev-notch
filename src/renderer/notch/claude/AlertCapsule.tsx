import { ClaudeMark } from '../../shared/brand-icons'
import type { CSSProperties } from 'react'
import type { PendingQuestionView } from '../../../shared/claude/types'
import { useClaude } from '../../shared/claude-store'
import { useQuestions } from '../../shared/questions-store'
import { useAttentionCount } from '../../shared/reminders-store'
import { useT } from '../../shared/use-t'
import { integrationStyle } from '../../shared/integration-color'
import { useSettings } from '../../shared/settings-store'
import { alertAllowed } from '../integration-visibility'
import { ReminderAlert } from '../reminders/ReminderAlert'
import { questionFirst } from './question-form'

/**
 * The coral capsule: the earliest pending Claude item, a permission (session and tool) or a question
 * ("Claude asks · project"), plus how many more Claude items wait. Claude wins when reminders are due
 * too; a small coral dot then says so. With nothing pending from Claude, the reminders alert shows.
 */
export function AlertCapsule() {
  const t = useT()
  const pending = useClaude((store) => store.state?.pending)
  const questions = useQuestions((store) => store.questions)
  const integrations = useSettings((store) => store.settings?.integrations ?? null)
  // Off integrations never alert: with Claude off its items are ignored, with reminders off neither the dot nor their alert shows.
  const claudeOn = integrations === null || alertAllowed('claude', integrations)
  const remindersOn = integrations === null || alertAllowed('reminder', integrations)
  const remindersDue = useAttentionCount()
  const permissions = claudeOn ? (pending ?? []) : []
  const asked = claudeOn ? (questions ?? []) : []
  const more = permissions.length + asked.length - 1
  const reminderDot = remindersOn && remindersDue > 0 && (
    <span
      data-testid="claude-alert-reminder-dot"
      role="img"
      aria-label={t('reminders.alert.alsoDue')}
      className="size-1.5 shrink-0 rounded-full bg-wait"
    />
  )
  const moreBadge = more > 0 && (
    <span className="tabular shrink-0 text-label font-semibold text-wait">{t('claude.alert.more', { count: more })}</span>
  )

  if (questionFirst(permissions, asked)) {
    const question = asked.reduce<PendingQuestionView>((a, b) => (b.arrivedAt < a.arrivedAt ? b : a), asked[0]!)
    return (
      <div
        data-testid="claude-question-alert"
        role="status"
        aria-label={`${t('claude.alert.questionLabel')}: ${question.project}`}
        className="flex h-full items-center gap-2 px-3.5"
        style={integrations ? integrationStyle(integrations.claude.color) : undefined}
      >
        {/* Needs you: the pulsing coral dot, then Claude's icon in its integration color. */}
        <span aria-hidden="true" className="status-dot pulse-wait" style={{ '--dot': 'var(--color-wait)' } as CSSProperties} />
        <ClaudeMark size={13} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-[color:var(--int,var(--color-int-default))]" />
        {/* Claude's texts are always plain text: React escapes them. */}
        <span className="min-w-0 flex-1 truncate text-body text-chalk">
          <span className="font-semibold">{t('claude.alert.question')}</span>
          <span className="text-graphite-glass"> · </span>
          <span className="text-graphite-glass">{question.project}</span>
        </span>
        {moreBadge}
        {reminderDot}
      </div>
    )
  }

  const oldest = permissions[0]
  if (!oldest) return remindersOn ? <ReminderAlert /> : null

  return (
    <div
      data-testid="claude-alert"
      role="status"
      aria-label={`${t('claude.alert.label')}: ${oldest.sessionName}, ${oldest.toolName}`}
      className="flex h-full items-center gap-2 px-3.5"
      style={integrations ? integrationStyle(integrations.claude.color) : undefined}
    >
      {/* Needs you: the pulsing coral dot, then Claude's icon in its integration color. */}
      <span aria-hidden="true" className="status-dot pulse-wait" style={{ '--dot': 'var(--color-wait)' } as CSSProperties} />
      <ClaudeMark size={13} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-[color:var(--int,var(--color-int-default))]" />
      <span className="min-w-0 flex-1 truncate text-body text-chalk">
        <span className="font-semibold">{oldest.sessionName}</span>
        <span className="text-graphite-glass"> · </span>
        <span className="font-mono text-small text-graphite-glass">{oldest.toolName}</span>
      </span>
      {moreBadge}
      {reminderDot}
    </div>
  )
}
