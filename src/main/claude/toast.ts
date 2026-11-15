import type { PendingPermission, PendingQuestionView } from '../../shared/claude/types'
import type { MessageKey } from '../../shared/i18n/messages'

export type ToastRequest = { title: string; body: string; onClick: () => void }

export interface PermissionToast {
  show(permission: PendingPermission, onClick: () => void): void
}

export interface PermissionToastOptions {
  notify: (toast: ToastRequest) => void
  translate: (key: MessageKey) => string
}

/** Informational toast: never carries the command or tool input, and has no buttons. */
export function createPermissionToast(options: PermissionToastOptions): PermissionToast {
  return {
    show(permission, onClick) {
      options.notify({
        title: options.translate('claude.toast.title'),
        body: permission.sessionName,
        onClick,
      })
    },
  }
}

export interface QuestionToast {
  show(question: PendingQuestionView, onClick: () => void): void
}

/** Informational toast: the project only, never the question, its options or anything to answer with. */
export function createQuestionToast(options: PermissionToastOptions): QuestionToast {
  return {
    show(question, onClick) {
      options.notify({ title: options.translate('claude.toast.question'), body: question.project, onClick })
    },
  }
}
