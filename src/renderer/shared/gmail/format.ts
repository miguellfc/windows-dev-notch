import { GMAIL_UNREAD_CAP, type GmailMessage, type GmailState } from '../../../shared/gmail/schema'
import { translate } from '../../../shared/i18n/messages'
import type { Language } from '../../../shared/settings/schema'
import { formatEdited } from '../notes/format'

/** The unread count as shown: main caps it at 100, which means "more than 99". */
export function unreadText(count: number): string {
  return count >= GMAIL_UNREAD_CAP ? '99+' : String(count)
}

/** Accessible name of an unread count: "3 correos sin leer" / "1 unread email". */
export function unreadLabel(count: number, language: Language): string {
  return count === 1
    ? translate(language, 'gmail.capsule.unreadOne')
    : translate(language, 'gmail.capsule.unread', { count: unreadText(count) })
}

const parse = (iso: string): Date | null => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

/** How long ago a message arrived, in the notes format ("hace 3 min", "ayer"); '' for a bad date. */
export function formatReceived(iso: string, now: Date, language: Language): string {
  const date = parse(iso)
  return date ? formatEdited(date, now, language) : ''
}

/** "Actualizado hace 3 min" / "Updated 3 min. ago" for the last successful query; '' without one. */
export function formatUpdated(updatedAt: string | null, now: Date, language: Language): string {
  const date = updatedAt === null ? null : parse(updatedAt)
  return date ? translate(language, 'gmail.view.updated', { time: formatEdited(date, now, language) }) : ''
}

/** The subject as shown, or "(sin asunto)" / "(no subject)" when it is blank. */
export function subjectText(subject: string, language: Language): string {
  return subject.trim() === '' ? translate(language, 'gmail.view.noSubject') : subject
}

/** The last `gmail:recent` answer and the `updatedAt` of the state that triggered the request. */
export interface GmailRecent {
  messages: readonly GmailMessage[]
  forUpdate: string | null
}

export type GmailBody = 'loading' | 'list' | 'empty' | 'unconfigured' | 'signed-out' | 'signing-in' | 'expired'

/**
 * What the Gmail view's body shows. While `ok`, an empty list is not trusted when it predates the
 * view (opening it starts a poll in main) or when the count says there is unread mail: the
 * skeleton stays until a list that agrees arrives, never "No hay correos en Principal".
 * Offline without a list, "empty" needs a past query that counted 0 unread; otherwise the skeleton
 * stays (the footer already says the notch is offline).
 */
export function gmailBody(state: GmailState | null, recent: GmailRecent | null, openedAt: number): GmailBody {
  if (!state) return 'loading'
  if (state.status !== 'ok' && state.status !== 'offline') return state.status
  if (!recent) return 'loading'
  if (recent.messages.length > 0) return 'list'
  if (state.status === 'offline') return state.updatedAt !== null && (state.unread ?? 0) === 0 ? 'empty' : 'loading'
  const fresh = recent.forUpdate !== null && Date.parse(recent.forUpdate) >= openedAt
  return fresh && (state.unread ?? 0) === 0 ? 'empty' : 'loading'
}
