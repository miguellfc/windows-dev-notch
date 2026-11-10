import { translate, type MessageKey } from '../../../shared/i18n/messages'
import type { IpcError } from '../../../shared/ipc/result'
import type { ParseError } from '../../../shared/reminders/parse'
import { REMINDER_DONE_MESSAGE, REMINDER_PAST_MESSAGE, type Reminder } from '../../../shared/reminders/schema'
import type { Language } from '../../../shared/settings/schema'

const DAY_MS = 24 * 60 * 60 * 1000

const localeOf = (language: Language): string => (language === 'es' ? 'es-ES' : 'en-US')

/** Whole local calendar days from `now`'s date to `date`'s date (DST-safe). */
function dayOffset(date: Date, now: Date): number {
  const a = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((a - b) / DAY_MS)
}

/**
 * When a reminder is due, in the user's language: "hoy 16:30" / "today 4:30 PM",
 * "mañana 9:00" / "tomorrow 9:00 AM", a short weekday within a week, else day and month.
 */
export function formatDue(due: Date, now: Date, language: Language): string {
  const locale = localeOf(language)
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(due)
  const offset = dayOffset(due, now)
  if (offset === 0) return translate(language, 'reminders.when.today', { time })
  if (offset === 1) return translate(language, 'reminders.when.tomorrow', { time })
  const day =
    Math.abs(offset) < 7
      ? new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(due)
      : new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(due)
  return `${day} ${time}`
}

const dueMs = (r: Reminder): number => new Date(r.dueAt).getTime()
const byDue = (a: Reminder, b: Reminder): number => dueMs(a) - dueMs(b)

/** Reminders that need attention now (due or missed), oldest first. */
export function attentionReminders(reminders: readonly Reminder[]): Reminder[] {
  return reminders.filter((r) => r.state === 'due' || r.state === 'missed').sort(byDue)
}

/** Every pending reminder, soonest first. */
export function pendingReminders(reminders: readonly Reminder[]): Reminder[] {
  return reminders.filter((r) => r.state === 'pending').sort(byDue)
}

const ERROR_KEYS: Readonly<Record<string, MessageKey>> = {
  'empty-text': 'reminders.error.emptyText',
  'no-time': 'reminders.error.noTime',
  'too-long': 'reminders.error.tooLong',
  limit: 'reminders.error.limit',
}

/**
 * Message for a failed reminders call: parse codes and the limit by name, read-only, a reminder
 * that is gone (deleted or already done elsewhere), else generic.
 */
export function reminderErrorKey(error: IpcError): MessageKey {
  if (error.code === 'READ_ONLY') return 'reminders.notice.readOnly'
  if (error.code === 'NOT_FOUND') return 'reminders.error.notFound'
  if (error.code === 'INVALID_INPUT') {
    if (error.message === REMINDER_PAST_MESSAGE) return 'reminders.error.past'
    if (error.message === REMINDER_DONE_MESSAGE) return 'reminders.error.notFound'
    return ERROR_KEYS[error.message] ?? 'error.generic'
  }
  return 'error.generic'
}

/** Message for a local parse error (live preview). */
export function parseErrorKey(error: ParseError['error']): MessageKey {
  return ERROR_KEYS[error] ?? 'error.generic'
}
