import type { Reminder } from '../../../shared/reminders/schema'

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

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** ISO instant to the `YYYY-MM-DDTHH:mm` local value of a datetime-local input (seconds dropped). */
export function isoToLocalInput(iso: string): string {
  const d = new Date(iso)
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

/** A datetime-local value (local wall clock) to an ISO instant, or null if empty or not a real time. */
export function localInputToIso(value: string): string | null {
  const m = LOCAL_INPUT.exec(value)
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number]
  const date = new Date(y, mo - 1, d, h, mi)
  const exact =
    date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d && date.getHours() === h && date.getMinutes() === mi
  return exact ? date.toISOString() : null
}

/** True when an ISO instant is not strictly after `now` (the main process rejects those on update). */
export function isNotInFuture(iso: string, now: Date): boolean {
  return new Date(iso).getTime() <= now.getTime()
}

/** An open edit stays valid only while its reminder exists and is not done (done rows are read-only). */
export function isDraftLive(id: string, reminders: readonly Reminder[] | null): boolean {
  return reminders?.some((r) => r.id === id && r.state !== 'done') ?? false
}
