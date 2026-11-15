import { create } from 'zustand'
import type { Reminder } from '../../shared/reminders/schema'

export type RemindersNotice = 'quarantined' | 'read-only' | null

interface RemindersStoreState {
  /** Null until the first snapshot arrives. */
  reminders: Reminder[] | null
  notice: RemindersNotice
}

export const useReminders = create<RemindersStoreState>(() => ({ reminders: null, notice: null }))

/** How many reminders need attention (due or missed): the badge and the alert capsule count. */
export function useAttentionCount(): number {
  return useReminders(
    (store) => store.reminders?.filter((r) => r.state === 'due' || r.state === 'missed').length ?? 0,
  )
}

/** Keeps the store in sync with the main process; subscribe first so an early read never wins. */
export function bindReminders(): void {
  let pushed = false
  window.notch.events.on('reminders:changed', ({ reminders, notice }) => {
    pushed = true
    useReminders.setState({ reminders, notice })
  })
  void window.notch.reminders.list().then((result) => {
    if (result.ok && !pushed) useReminders.setState({ reminders: result.data.reminders, notice: result.data.notice })
  })
}
