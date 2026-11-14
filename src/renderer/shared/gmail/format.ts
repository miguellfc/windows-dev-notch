import { GMAIL_UNREAD_CAP, type GmailMessage, type GmailNewMail, type GmailState } from '../../../shared/gmail/schema'
import { translate } from '../../../shared/i18n/messages'
import type { NotchMode } from '../../../shared/notch/state'
import type { Language } from '../../../shared/settings/schema'
import { formatEdited } from '../notes/format'
import { locale } from '../locale'

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

export type GmailBody = 'loading' | 'list' | 'empty' | 'unconfigured' | 'signed-out' | 'signing-in' | 'expired' | 'scope'

/**
 * What the Gmail view's body shows. While `ok`, an empty list is not trusted when it predates the
 * view (opening it starts a poll in main) or when the count says there is unread mail: the
 * skeleton stays until a list that agrees arrives, never "No hay correos en Principal".
 * Offline without a list, "empty" needs a past query that counted 0 unread; otherwise the skeleton
 * stays (the footer already says the notch is offline). A session that expired because it lacks the
 * full-mail permission says so (`scope`), not just "expired".
 */
export function gmailBody(state: GmailState | null, recent: GmailRecent | null, openedAt: number): GmailBody {
  if (!state) return 'loading'
  if (state.status === 'expired' && state.reason === 'scope') return 'scope'
  if (state.status !== 'ok' && state.status !== 'offline') return state.status
  if (!recent) return 'loading'
  if (recent.messages.length > 0) return 'list'
  if (state.status === 'offline') return state.updatedAt !== null && (state.unread ?? 0) === 0 ? 'empty' : 'loading'
  const fresh = recent.forUpdate !== null && Date.parse(recent.forUpdate) >= openedAt
  return fresh && (state.unread ?? 0) === 0 ? 'empty' : 'loading'
}

/** What the new-mail alert shows: sender and subject of one mail, or a plain line. */
export type MailAlertContent = { kind: 'content'; from: string; subject: string } | { kind: 'plain'; text: string }

/**
 * "Ana García · Presupuesto…" for one mail with its content; "Correo nuevo" when the user hides
 * the content or main had no data; "3 correos nuevos" for several.
 */
export function mailAlertContent(mail: GmailNewMail, language: Language): MailAlertContent {
  if (mail.count > 1) return { kind: 'plain', text: translate(language, 'gmail.alert.many', { count: mail.count }) }
  if (mail.from === undefined || mail.from.trim() === '') return { kind: 'plain', text: translate(language, 'gmail.alert.new') }
  return { kind: 'content', from: mail.from, subject: subjectText(mail.subject ?? '', language) }
}

/** Accessible name of the alert: the same text, with "Correo nuevo:" in front of a sender. */
export function mailAlertLabel(mail: GmailNewMail, language: Language): string {
  const content = mailAlertContent(mail, language)
  return content.kind === 'plain' ? content.text : `${translate(language, 'gmail.alert.label')}: ${content.from} · ${content.subject}`
}

/** The sender's name and, when it adds something, the address. */
export function senderParts(from: string, fromAddress: string): { name: string; address: string | null } {
  const name = from.trim()
  const address = fromAddress.trim()
  if (name === '') return { name: address, address: null }
  return { name, address: address === '' || address === name ? null : address }
}

/** The full date and time of a message ("miércoles, 11 de noviembre de 2026, 9:05"); '' for a bad date. */
export function formatFullDate(iso: string, language: Language): string {
  const date = parse(iso)
  return date ? new Intl.DateTimeFormat(locale(language), { dateStyle: 'full', timeStyle: 'short' }).format(date) : ''
}

/** "1 adjunto" / "3 adjuntos". */
export function attachmentsText(count: number, language: Language): string {
  return count === 1 ? translate(language, 'gmail.reader.attachmentOne') : translate(language, 'gmail.reader.attachments', { count })
}

/**
 * Whether the open message survives a mode change: in the Gmail view, and in the alert (a click on
 * a single-mail alert sets it just before the view opens). Anything else leaves the reader.
 */
export function keepsReader(mode: NotchMode): boolean {
  return mode === 'gmail' || mode === 'alert'
}

/**
 * Whether an open message survives a new session reading: only while the session is live (`ok` or
 * `offline`). A sign-out or an expired session closes the reader, so the body leaves the renderer.
 * Before the first reading (null) nothing is open to close.
 */
export function sessionKeepsReader(state: GmailState | null): boolean {
  return state === null || state.status === 'ok' || state.status === 'offline'
}

/**
 * Row to focus when the list comes back from the reader: the same message, else the row that took
 * its index (it was deleted), else the last row; null for an empty list.
 */
export function returnRowIndex(ids: readonly string[], from: { id: string; index: number }): number | null {
  if (ids.length === 0) return null
  const same = ids.indexOf(from.id)
  return same !== -1 ? same : Math.min(Math.max(from.index, 0), ids.length - 1)
}
