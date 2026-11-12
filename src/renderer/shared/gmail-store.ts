import { create } from 'zustand'
import type { GmailState } from '../../shared/gmail/schema'
import { EMPTY_MAIL, nextMail, type MailLatch } from '../notch/system/capsule-latch'

interface GmailStoreState {
  /** Session and unread count from main; null until the first reading. Never tokens or mail. */
  state: GmailState | null
  /** The compact capsule's unread-mail block, latched so one reading without mail does not change its width. */
  mail: MailLatch
}

export const useGmail = create<GmailStoreState>(() => ({ state: null, mail: EMPTY_MAIL }))

const apply = (state: GmailState) => useGmail.setState((store) => ({ state, mail: nextMail(store.mail, state) }))

/** Keeps the store in sync with the main process; subscribe first so an early read never wins. */
export function bindGmail(): void {
  let pushed = false
  window.notch.events.on('gmail:state', (state) => {
    pushed = true
    apply(state)
  })
  void window.notch.gmail.getState().then((result) => {
    if (result.ok && !pushed) apply(result.data)
  })
}
