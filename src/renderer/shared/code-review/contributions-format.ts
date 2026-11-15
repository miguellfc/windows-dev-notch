import { buildGrid, localDate, monthRange } from '../../../shared/code-review/contributions'
import type { ContributionDay, ContributionsResult, ContributionSummary } from '../../../shared/code-review/schema'
import { translate } from '../../../shared/i18n/messages'
import type { Language } from '../../../shared/settings/schema'
import { locale } from '../locale'

/** A total the summary does not have (still loading, or the query failed). */
export const NO_VALUE = '—'

/** "7 contribuciones" / "1 contribución" / "1 contribution". */
export function contributionsText(count: number, language: Language): string {
  return count === 1 ? translate(language, 'codeReview.contrib.countOne') : translate(language, 'codeReview.contrib.count', { count })
}

/** A summary cell: the number, or "—" without one. */
export function totalText(value: number | null | undefined): string {
  return value === null || value === undefined ? NO_VALUE : String(value)
}

/** `YYYY-MM-DD` (or `YYYY-MM`, the 1st) as a local date, noon so no time zone shift moves the day. */
const parseDay = (key: string): Date => {
  const [year = 1970, month = 1, dayOfMonth = 1] = key.split('-').map(Number)
  return new Date(year, month - 1, dayOfMonth, 12)
}

const capitalize = (text: string, language: Language): string => text.charAt(0).toLocaleUpperCase(locale(language)) + text.slice(1)

/** The month's name ("noviembre" / "November"), capitalised for the start of a sentence or a heading. */
export function monthName(month: string, language: Language, capitalized = false): string {
  const name = new Intl.DateTimeFormat(locale(language), { month: 'long' }).format(parseDay(month))
  return capitalized ? capitalize(name, language) : name
}

/** "12 nov" / "Nov 12". */
export function shortDate(date: string, language: Language): string {
  return new Intl.DateTimeFormat(locale(language), { day: 'numeric', month: 'short' }).format(parseDay(date)).replace('.', '')
}

/** Weekday names Monday → Sunday: `narrow` for the chart's row labels (L, X, V), `long` for screen readers. */
export function weekdayNames(language: Language, style: 'narrow' | 'long'): string[] {
  const format = new Intl.DateTimeFormat(locale(language), { weekday: style })
  // 2024-01-01 was a Monday.
  return Array.from({ length: 7 }, (_, index) => format.format(new Date(2024, 0, 1 + index, 12)))
}

/** What hovering or focusing a square says: "12 nov · 7 contribuciones"; a future day, only its date. */
export function dayCellLabel(day: ContributionDay, language: Language): string {
  const date = shortDate(day.date, language)
  return day.future ? date : `${date} · ${contributionsText(day.count, language)}`
}

/** "84 contribuciones en noviembre" / "84 contributions in November". */
export function monthTotalText(summary: ContributionSummary, language: Language): string {
  return translate(language, 'codeReview.contrib.monthTotal', {
    contributions: contributionsText(summary.monthTotal, language),
    month: monthName(summary.month, language),
  })
}

/** The chart for screen readers: "Noviembre: 84 contribuciones en 15 días activos". */
export function graphSummaryText(summary: ContributionSummary, language: Language): string {
  const days =
    summary.activeDays === 1
      ? translate(language, 'codeReview.contrib.activeDaysOne')
      : translate(language, 'codeReview.contrib.activeDays', { count: summary.activeDays })
  return translate(language, 'codeReview.contrib.srSummary', {
    month: monthName(summary.month, language, true),
    contributions: contributionsText(summary.monthTotal, language),
    days,
  })
}

export type ContributionsPhase = 'loading' | 'error' | 'ready'

/**
 * What the contributions block shows for one platform's last `code-review:contributions` answer:
 * the grey chart until a summary arrives (or the error line when the query failed without one);
 * with a summary, its data, plus the error line while the last query failed.
 */
export function contributionsPhase(result: ContributionsResult | undefined): {
  phase: ContributionsPhase
  summary: ContributionSummary | null
  error: boolean
} {
  if (!result) return { phase: 'loading', summary: null, error: false }
  if (result.summary) return { phase: 'ready', summary: result.summary, error: result.error }
  return { phase: result.error ? 'error' : 'loading', summary: null, error: result.error }
}

/** The current month's chart with nothing in it: the static grey grid while loading or failed. */
export function placeholderGrid(now: Date): ContributionDay[][] {
  return buildGrid(monthRange(now).month, new Map(), localDate(now))
}

/**
 * Keyboard move in the chart (columns are weeks, rows Monday → Sunday): ↑/↓ the previous/next day,
 * ←/→ the same weekday a week before/after, Home/End the first/last day of the month in the same row.
 * Never leaves the month; null when the key does not move (or the date is not a day of the month).
 */
export function gridKeyTarget(weeks: readonly (readonly ContributionDay[])[], from: string, key: string): string | null {
  const days = weeks.flat().filter((d) => d.inMonth)
  const index = days.findIndex((d) => d.date === from)
  if (index === -1) return null
  const at = (i: number): string | null => days[i]?.date ?? null
  switch (key) {
    case 'ArrowUp':
      return at(index - 1)
    case 'ArrowDown':
      return at(index + 1)
    case 'ArrowLeft':
      return at(index - 7)
    case 'ArrowRight':
      return at(index + 7)
    case 'Home':
    case 'End': {
      const column = weeks.findIndex((week) => week.some((d) => d.date === from))
      const weekday = weeks[column]?.findIndex((d) => d.date === from) ?? -1
      const same = weeks.map((week) => week[weekday]).filter((d): d is ContributionDay => d !== undefined && d.inMonth)
      const target = key === 'Home' ? same[0] : same.at(-1)
      return target?.date ?? null
    }
    default:
      return null
  }
}
