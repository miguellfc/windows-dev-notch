import type { ReminderPreset } from './schema'

const MINUTE_MS = 60_000
/** Upper bound for scanning day by day (covers weekends plus slack). */
const MAX_SCAN_DAYS = 10

/** Same calendar date as `day`, shifted by `days` whole local days, at 00:00 local. */
function startOfLocalDay(day: Date, days = 0): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + days)
}

/**
 * Instant of wall-clock `hhmm` ("HH:mm") on the local calendar date of `day`.
 * A wall time skipped by a DST spring-forward resolves to the first valid instant after the gap;
 * an ambiguous wall time on fall-back resolves to its first occurrence.
 */
export function atLocalTime(day: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number) as [number, number]
  const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m)
  if (candidate.getHours() === h && candidate.getMinutes() === m) return candidate

  // Nonexistent wall time: the engine shifted it forward by the gap length. Walk back to the
  // transition instant (the first minute that already uses the post-gap offset).
  const offset = candidate.getTimezoneOffset()
  let t = candidate.getTime()
  for (let i = 0; i < 180 && new Date(t - MINUTE_MS).getTimezoneOffset() === offset; i++) {
    t -= MINUTE_MS
  }
  return new Date(t)
}

/** Next occurrence of `localTime` strictly after `after`; `weekdays` skips Saturday and Sunday. */
export function nextOccurrence(
  repeat: 'daily' | 'weekdays',
  localTime: string,
  after: Date,
): Date {
  for (let i = 0; i <= MAX_SCAN_DAYS; i++) {
    const day = startOfLocalDay(after, i)
    const weekday = day.getDay()
    if (repeat === 'weekdays' && (weekday === 0 || weekday === 6)) continue
    const candidate = atLocalTime(day, localTime)
    if (candidate.getTime() > after.getTime()) return candidate
  }
  // Unreachable for valid input; keeps the function total.
  return atLocalTime(startOfLocalDay(after, MAX_SCAN_DAYS + 1), localTime)
}

export function presetDueAt(preset: ReminderPreset, now: Date): Date {
  switch (preset) {
    case '15m':
      return new Date(now.getTime() + 15 * MINUTE_MS)
    case '1h':
      return new Date(now.getTime() + 60 * MINUTE_MS)
    case 'tomorrow-9':
      return atLocalTime(startOfLocalDay(now, 1), '09:00')
  }
}
