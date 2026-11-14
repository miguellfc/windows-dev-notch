import type { Reminder } from '../../../shared/reminders/schema'
import { atLocalTime, nextOccurrence } from '../../../shared/reminders/time'

/** Day choice in the notch's new-reminder form. */
export type FormDay = 'today' | 'tomorrow' | 'other'

export interface DueFields {
  day: FormDay
  /** `YYYY-MM-DD` from the date input; only read when `day` is `other`. */
  date?: string
  /** What the user typed in the 24 h time field (`H:mm` or `HH:mm`). */
  time: string
  repeat: Reminder['repeat']
}

export type DueResult = { dueAt: Date } | { error: 'time' | 'date' | 'past' }

const pad = (n: number): string => String(n).padStart(2, '0')
const QUARTER = 15
const DAY_MINUTES = 24 * 60

/** The next quarter hour strictly after `now` (16:07 → 16:15; 23:50 → tomorrow 00:00). */
export function nextQuarterHour(now: Date): { day: 'today' | 'tomorrow'; time: string } {
  const next = (Math.floor((now.getHours() * 60 + now.getMinutes()) / QUARTER) + 1) * QUARTER
  const day = next >= DAY_MINUTES ? 'tomorrow' : 'today'
  const minutes = next % DAY_MINUTES
  return { day, time: `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}` }
}

/** `H:mm` / `HH:mm` (24 h, 00:00–23:59) → `HH:mm`, else null. */
export function parseClock(input: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(input.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return `${pad(hours)}:${pad(minutes)}`
}

/** Local calendar date of `now` as `YYYY-MM-DD` (the date input's value and `min`). */
export function todayIsoDate(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** The local calendar date after `now`'s, as `YYYY-MM-DD` (the "Other day" default). */
export function tomorrowIsoDate(now: Date): string {
  return todayIsoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))
}

/** `YYYY-MM-DD` → local midnight of that date, or null when it is not a real calendar date. */
function parseIsoDate(value: string | undefined): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '')
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return date
}

/**
 * The instant the form describes. One-off: the chosen day at the typed local time (DST-safe via
 * atLocalTime), which must be after `now`. Repeating: the day is ignored and the result is the
 * next occurrence of that wall-clock time (main recomputes it the same way).
 */
export function buildDueAt(fields: DueFields, now: Date): DueResult {
  const time = parseClock(fields.time)
  if (time === null) return { error: 'time' }
  if (fields.repeat !== 'none') return { dueAt: nextOccurrence(fields.repeat, time, now) }

  let day: Date | null
  if (fields.day === 'other') day = parseIsoDate(fields.date)
  else day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (fields.day === 'tomorrow' ? 1 : 0))
  if (day === null) return { error: 'date' }

  const dueAt = atLocalTime(day, time)
  return dueAt.getTime() <= now.getTime() ? { error: 'past' } : { dueAt }
}
