import type { MessageKey, MessageParams } from '../../shared/i18n/messages'
import type { Reminder } from '../../shared/reminders/schema'

/** What the Electron adapter turns into a Windows toast. Silent: the notch plays its own chime. */
export type ReminderToastRequest = { title: string; body: string; silent: true; onClick: () => void }

export interface ReminderToast {
  /** One toast for a whole batch that just became due. */
  fired(batch: readonly Reminder[]): void
  /** One toast for the reminders missed while the app was closed or the PC asleep. */
  missed(count: number): void
}

export interface ReminderToastOptions {
  notify: (toast: ReminderToastRequest) => void
  translate: (key: MessageKey, params?: MessageParams) => string
  /** Clicking the toast body; opens the notch on the reminders view. */
  onClick: () => void
}

const BODY_TEXTS = 2

/**
 * Toast without buttons (Task 0 verdict B): Windows did not reliably deliver button clicks,
 * so Snooze and Complete live in the notch view the click opens.
 */
export function createReminderToast({ notify, translate, onClick }: ReminderToastOptions): ReminderToast {
  const show = (title: string, body: string) => notify({ title, body, silent: true, onClick })
  return {
    fired(batch) {
      if (batch.length === 0) return
      if (batch.length === 1) {
        show(translate('reminders.toast.title'), batch[0]!.text)
        return
      }
      show(
        translate('reminders.toast.titleMany', { count: batch.length }),
        batch
          .slice(0, BODY_TEXTS)
          .map((r) => r.text)
          .join(' · '),
      )
    },
    missed(count) {
      if (count <= 0) return
      show(
        translate('reminders.toast.missedTitle'),
        count === 1 ? translate('reminders.toast.missedOne') : translate('reminders.toast.missedMany', { count }),
      )
    },
  }
}
