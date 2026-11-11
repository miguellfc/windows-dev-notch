import { hasVisibleText, REMINDER_TEXT_MAX, type Reminder } from './schema'
import { atLocalTime, MINUTE_MS, nextOccurrence, startOfLocalDay } from './time'

export type ParsedReminder = {
  text: string
  dueAt: Date
  repeat: Reminder['repeat']
  localTime?: string
}

export type ParseError = { error: 'empty-text' | 'no-time' | 'too-long' }

const MAX_RELATIVE_MINUTES = 7 * 24 * 60

const AT = String.raw`(?:(?:a\s+las|at)\s+)?`
// Groups: 1=H 2=mm 3=am/pm (H:mm form) | 4=H 5=am/pm (bare form). Must end at whitespace or end.
const TIME = String.raw`(?:(\d{1,2}):(\d{2})\s?(am|pm)?|(\d{1,2})\s?(am|pm))(?=\s|$)`

const RELATIVE_RE = new RegExp(
  String.raw`^(?:en|in)\s+(\d+)\s*(minutos|minuto|minutes|minute|mins|min|horas|hora|hours|hour|h|m)(?=\s|$)`,
  'i',
)
const TOMORROW_RE = new RegExp(String.raw`^(?:ma[nñ]ana|tomorrow)\s+${AT}${TIME}`, 'i')
const DAILY_RE = new RegExp(
  String.raw`^(?:diario|daily|cada\s+d[ií]a|every\s+day)\s+${AT}${TIME}`,
  'i',
)
const WEEKDAYS_RE = new RegExp(String.raw`^(?:laborables|weekdays)\s+${AT}${TIME}`, 'i')
const PLAIN_RE = new RegExp(String.raw`^${AT}${TIME}`, 'i')

/** Zero-padded `HH:mm` from a TIME match, or null when out of range. */
function timeFromMatch(m: RegExpExecArray): string | null {
  const hasColon = m[1] !== undefined
  const hour = Number(hasColon ? m[1] : m[4])
  const minute = hasColon ? Number(m[2]) : 0
  const meridiem = (hasColon ? m[3] : m[5])?.toLowerCase()
  if (minute > 59) return null
  let h24 = hour
  if (meridiem) {
    if (hour < 1 || hour > 12) return null
    h24 = (hour % 12) + (meridiem === 'pm' ? 12 : 0)
  } else if (hour > 23) {
    return null
  }
  return `${String(h24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function finish(
  rest: string,
  build: () => Omit<ParsedReminder, 'text'>,
): ParsedReminder | ParseError {
  const text = rest.trim()
  if (!hasVisibleText(text)) return { error: 'empty-text' }
  if (text.length > REMINDER_TEXT_MAX) return { error: 'too-long' }
  return { text, ...build() }
}

/**
 * Parses `"en 30 min revisar PR"`, `"16:00 standup"`, `"mañana 9:00 x"`, `"diario 9:00 x"`, ...
 * Control characters in the text are left to the caller's schema validation.
 */
export function parseReminder(input: string, now: Date): ParsedReminder | ParseError {
  const source = input.normalize('NFC').trim()

  const rel = RELATIVE_RE.exec(source)
  if (rel) {
    const amount = Number(rel[1])
    const isHours = rel[2]!.toLowerCase().startsWith('h')
    const minutes = isHours ? amount * 60 : amount
    if (minutes < 1 || minutes > MAX_RELATIVE_MINUTES) return { error: 'no-time' }
    return finish(source.slice(rel[0].length), () => ({
      dueAt: new Date(now.getTime() + minutes * MINUTE_MS),
      repeat: 'none',
    }))
  }

  for (const [re, repeat] of [
    [DAILY_RE, 'daily'],
    [WEEKDAYS_RE, 'weekdays'],
  ] as const) {
    const m = re.exec(source)
    if (!m) continue
    const hhmm = timeFromMatch(m)
    if (!hhmm) return { error: 'no-time' }
    return finish(source.slice(m[0].length), () => ({
      dueAt: nextOccurrence(repeat, hhmm, now),
      repeat,
      localTime: hhmm,
    }))
  }

  const tomorrow = TOMORROW_RE.exec(source)
  if (tomorrow) {
    const hhmm = timeFromMatch(tomorrow)
    if (!hhmm) return { error: 'no-time' }
    return finish(source.slice(tomorrow[0].length), () => ({
      dueAt: atLocalTime(startOfLocalDay(now, 1), hhmm),
      repeat: 'none',
    }))
  }

  const plain = PLAIN_RE.exec(source)
  if (plain) {
    const hhmm = timeFromMatch(plain)
    if (!hhmm) return { error: 'no-time' }
    return finish(source.slice(plain[0].length), () => ({
      dueAt: nextOccurrence('daily', hhmm, now),
      repeat: 'none',
    }))
  }

  return { error: 'no-time' }
}
