import type { PendingPermission } from '../../shared/claude/types'
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
