import { translate, type MessageKey } from '../../../shared/i18n/messages'
import type { IpcError } from '../../../shared/ipc/result'
import { NOTE_LIMIT_MESSAGE, NOTE_TEXT_MAX } from '../../../shared/notes/schema'
import type { Language } from '../../../shared/settings/schema'
import { hasVisibleText } from '../../../shared/text'
import { locale } from '../locale'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const LABEL_MAX = 40

/**
 * How long ago a note was edited: "ahora" / "just now" under a minute, then "hace 3 min",
 * "hace 2 h", "ayer", "hace 3 d" (Intl, short style), and the day and month from a week on.
 * Refreshed once a minute by `useClock`, so minutes are the finest unit.
 */
export function formatEdited(updatedAt: Date, now: Date, language: Language): string {
  const elapsed = now.getTime() - updatedAt.getTime()
  if (elapsed < MINUTE_MS) return translate(language, 'notes.time.now')
  const relative = new Intl.RelativeTimeFormat(locale(language), { numeric: 'auto', style: 'short' })
  if (elapsed < HOUR_MS) return relative.format(-Math.floor(elapsed / MINUTE_MS), 'minute')
  if (elapsed < DAY_MS) return relative.format(-Math.floor(elapsed / HOUR_MS), 'hour')
  if (elapsed < 7 * DAY_MS) return relative.format(-Math.floor(elapsed / DAY_MS), 'day')
  const sameYear = updatedAt.getFullYear() === now.getFullYear()
  return new Intl.DateTimeFormat(locale(language), {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(updatedAt)
}

/** A short name for a note in accessible labels ("Borrar: Comprar pan"): its first line, at most 40 characters. */
export function noteLabel(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '')?.trim() ?? ''
  return line.length > LABEL_MAX ? `${line.slice(0, LABEL_MAX)}…` : line
}

/** Local check before saving, matching main's rules: some visible text, at most 2000 characters once trimmed. */
export function validateNoteText(text: string): MessageKey | null {
  const trimmed = text.trim()
  if (!hasVisibleText(trimmed)) return 'notes.error.empty'
  if (trimmed.length > NOTE_TEXT_MAX) return 'notes.error.tooLong'
  return null
}

/** Message for a failed notes call: read-only session, a note that is gone, the 500-note limit, else generic. */
export function noteErrorKey(error: IpcError): MessageKey {
  if (error.code === 'READ_ONLY') return 'notes.notice.readOnly'
  if (error.code === 'NOT_FOUND') return 'notes.error.notFound'
  if (error.code === 'INVALID_INPUT' && error.message === NOTE_LIMIT_MESSAGE) return 'notes.error.limit'
  return 'error.generic'
}

/** Message for a failed undo: read-only session, else "could not undo". */
export function undoErrorKey(error: IpcError): MessageKey {
  return error.code === 'READ_ONLY' ? noteErrorKey(error) : 'notes.undo.failed'
}

const isIpcError = (value: unknown): value is IpcError =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { code?: unknown }).code === 'string' &&
  typeof (value as { message?: unknown }).message === 'string'

/** Message for a notes call that threw: a READ_ONLY error says so, anything else gets `fallback`. */
export function thrownNoteErrorKey(error: unknown, fallback: MessageKey): MessageKey {
  return isIpcError(error) && error.code === 'READ_ONLY' ? noteErrorKey(error) : fallback
}
