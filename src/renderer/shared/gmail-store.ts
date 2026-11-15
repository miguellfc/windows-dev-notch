import { create } from 'zustand'
import type { GmailNewMail, GmailState } from '../../shared/gmail/schema'
import { EMPTY_MAIL, nextMail, type MailLatch } from '../notch/system/capsule-latch'
import { sessionKeepsReader } from './gmail/format'

interface GmailStoreState {
  /** Session and unread count from main; null until the first reading. Never tokens or mail. */
  state: GmailState | null
  /** The compact capsule's unread-mail block, latched so one reading without mail does not change its width. */
  mail: MailLatch
  /** The last new-mail alert from main, what the alert capsule shows; null once it is spent. */
  newMail: GmailNewMail | null
  /** Id of the message open in the reader (the Gmail panel takes the reader's size); null on the list. */
  reading: string | null
  /** Main says the alert capsule shows the new-mail alert (not a permission or a reminder). */
  mailAlert: boolean
}

export const useGmail = create<GmailStoreState>(() => ({ state: null, mail: EMPTY_MAIL, newMail: null, reading: null, mailAlert: false }))

// A session that is no longer live closes the reader (its unmount tells main to drop the message).
const apply = (state: GmailState) =>
  useGmail.setState((store) => ({ state, mail: nextMail(store.mail, state), reading: sessionKeepsReader(state) ? store.reading : null }))

/** Remembers (or forgets) the alert payload; the capsule shows it while main's mode is `alert`. */
export const setNewMail = (newMail: GmailNewMail | null): void => useGmail.setState({ newMail })

/** Whether main's pending alert is the new-mail alert (`notch:mail-alert`). */
export const setMailAlert = (mailAlert: boolean): void => useGmail.setState({ mailAlert })

/** Opens a message in the reader, or goes back to the list with null. */
export const setReading = (reading: string | null): void => useGmail.setState({ reading })

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
