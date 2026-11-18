import { create } from 'zustand'
import type { GmailMessage, GmailNewMail, GmailState } from '../../shared/gmail/schema'
import type { NotchMode } from '../../shared/notch/state'
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
  /** The recent messages for the main panel's card; null until read, or once the session is gone. */
  recent: GmailMessage[] | null
}

export const useGmail = create<GmailStoreState>(() => ({ state: null, mail: EMPTY_MAIL, newMail: null, reading: null, mailAlert: false, recent: null }))

const isLive = (state: GmailState | null): boolean => state?.status === 'ok' || state?.status === 'offline'

/** Whether the notch shows the main panel; only `bindGmailPanel` moves it. */
let panelOpen = false
let recentRequest = 0

/** Reads main's last recent list. A slow answer never overwrites a newer one or an ended session. */
export async function loadRecent(): Promise<void> {
  recentRequest += 1
  const request = recentRequest
  const result = await window.notch.gmail.recent()
  if (result.ok && request === recentRequest) useGmail.setState({ recent: result.data })
}

// A session that is no longer live closes the reader (its unmount tells main to drop the message)
// and forgets its mail. Every reading may carry a new list for the open panel.
const apply = (state: GmailState) => {
  const live = isLive(state)
  if (!live) recentRequest += 1
  useGmail.setState((store) => ({
    state,
    mail: nextMail(store.mail, state),
    reading: sessionKeepsReader(state) ? store.reading : null,
    recent: live ? store.recent : null,
  }))
  if (live && panelOpen) void loadRecent()
}

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

/**
 * Follows the main panel, in the notch window only: reading the list also sets the ids main accepts
 * from the notch, so it must not run under the Gmail view (which reads its own) or Control Center.
 */
export function bindGmailPanel(): void {
  let pushed = false
  const follow = (mode: NotchMode) => {
    const opening = mode === 'expanded' && !panelOpen
    panelOpen = mode === 'expanded'
    if (opening && isLive(useGmail.getState().state)) void loadRecent()
  }
  window.notch.events.on('notch:mode-changed', (mode) => {
    pushed = true
    follow(mode)
  })
  void window.notch.notch.getMode().then((result) => {
    if (result.ok && !pushed) follow(result.data)
  })
}
