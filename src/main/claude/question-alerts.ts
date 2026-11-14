import type { PendingQuestionView } from '../../shared/claude/types'
import { PANEL_MODES, type NotchEvent, type NotchMode } from '../../shared/notch/state'
import { emitEvent, type EventTarget } from '../ipc/events'
import type { Logger } from '../services/logger'
import type { QuestionToast } from './toast'

export interface QuestionAlertsOptions {
  notch: { mode(): NotchMode; dispatch(event: NotchEvent): void }
  /** Only the notch gets Claude's questions (never the Control Center); null when its window is gone. */
  notchTarget: () => EventTarget | null
  toast: QuestionToast
  logger: Logger
}

export interface QuestionAlerts {
  /**
   * The pending permissions changed: call before dispatching `attention`, so the notch knows which
   * Claude item came first before the flag that may open it.
   */
  onPermissions(pending: readonly { receivedAt: number }[]): void
  onQuestions(questions: PendingQuestionView[]): void
  onNewQuestion(question: PendingQuestionView): void
}

const earliest = (stamps: readonly number[]): number | null => (stamps.length > 0 ? Math.min(...stamps) : null)

/**
 * Pushes pending Claude questions to the notch, raises its alert and toasts each new question once.
 * It also tells the notch which pending item (permission or question) arrived first: both carry a
 * stamp from the bridge's one strictly increasing clock, so the earliest opens first.
 */
export function createQuestionAlerts(options: QuestionAlertsOptions): QuestionAlerts {
  const { notch } = options
  let firstPermissionAt: number | null = null
  let firstQuestionAt: number | null = null
  const dispatchFirst = () => {
    const questionFirst = firstQuestionAt !== null && (firstPermissionAt === null || firstQuestionAt < firstPermissionAt)
    notch.dispatch({ type: 'claude-first', kind: questionFirst ? 'question' : 'permission' })
  }
  return {
    onPermissions(pending) {
      firstPermissionAt = earliest(pending.map((permission) => permission.receivedAt))
      dispatchFirst()
    },
    onQuestions(questions) {
      // The list goes first, so the capsule already knows what to show when the alert turns on.
      const target = options.notchTarget()
      emitEvent(target ? [target] : [], 'claude:questions', questions, options.logger)
      firstQuestionAt = earliest(questions.map((question) => question.arrivedAt))
      dispatchFirst()
      notch.dispatch({ type: 'question', on: questions.length > 0 })
    },
    onNewQuestion(question) {
      // Like a permission: the open panel already shows it; otherwise tell the user even if the capsule is hidden.
      if (!PANEL_MODES.has(notch.mode())) options.toast.show(question, () => notch.dispatch({ type: 'expand' }))
    },
  }
}
