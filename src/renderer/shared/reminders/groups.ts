import type { Reminder } from '../../../shared/reminders/schema'
import { todayIsoDate } from './form'

const DAY_MS = 24 * 60 * 60 * 1000
const dueMs = (r: Reminder): number => new Date(r.dueAt).getTime()
const doneMs = (r: Reminder): number => new Date(r.completedAt ?? r.dueAt).getTime()

export interface ReminderGroups {
  /** Due and missed, oldest first. */
  overdue: Reminder[]
  /** Pending, one-off, soonest first. */
  upcoming: Reminder[]
  /** Repeating and not already overdue, by next dueAt. */
  repeating: Reminder[]
  /** Done within the last 7 days, newest first. */
  completed: Reminder[]
}

/** Splits the list into the Control Center groups; every reminder lands in at most one. */
export function groupReminders(reminders: readonly Reminder[], now: Date): ReminderGroups {
  const overdue = reminders.filter((r) => r.state === 'due' || r.state === 'missed').sort((a, b) => dueMs(a) - dueMs(b))
  const upcoming = reminders.filter((r) => r.state === 'pending' && r.repeat === 'none').sort((a, b) => dueMs(a) - dueMs(b))
  const repeating = reminders.filter((r) => r.state === 'pending' && r.repeat !== 'none').sort((a, b) => dueMs(a) - dueMs(b))
  const since = now.getTime() - 7 * DAY_MS
  const completed = reminders.filter((r) => r.state === 'done' && doneMs(r) >= since).sort((a, b) => doneMs(b) - doneMs(a))
  return { overdue, upcoming, repeating, completed }
}

const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * ISO instant to the edit form's fields: the local date (`YYYY-MM-DD`, the date input's value)
 * and the 24 h `HH:mm` time (seconds dropped). The form reads them back with `buildDueAt`.
 */
export function isoToDueFields(iso: string): { date: string; time: string } {
  const d = new Date(iso)
  return { date: todayIsoDate(d), time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }
}

/** An open edit stays valid only while its reminder exists and is not done (done rows are read-only). */
export function isDraftLive(id: string, reminders: readonly Reminder[] | null): boolean {
  return reminders?.some((r) => r.id === id && r.state !== 'done') ?? false
}
