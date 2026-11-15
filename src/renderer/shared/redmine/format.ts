import { buildGrid } from '../../../shared/code-review/contributions'
import type { ContributionDay, ContributionLevel } from '../../../shared/code-review/schema'
import { translate, type MessageKey } from '../../../shared/i18n/messages'
import type { RedmineIssue, RedmineSummary, RedmineWriteError } from '../../../shared/redmine/schema'
import type { Language } from '../../../shared/settings/schema'
import { locale } from '../locale'

const hoursNumber = (hours: number, language: Language): string => new Intl.NumberFormat(locale(language), { maximumFractionDigits: 2 }).format(hours)

/** Hours as the capsule and the lists show them: "5,5h" / "5.5h", at most 2 decimals, no trailing zeros, "0h". */
export function hoursText(hours: number, language: Language): string {
  return `${hoursNumber(hours, language)}h`
}

/** Hours for sentences and accessible names: "5,5 h" / "5.5 h". */
export function hoursLong(hours: number, language: Language): string {
  return `${hoursNumber(hours, language)} h`
}

/** Lower case without accents, so "diseno" finds "Diseño". */
const fold = (text: string): string => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

/**
 * The search box over the assigned issues: a query that is a number (with or without `#`) matches
 * that exact id (`#12` never matches issue 123); any query also matches the subject and the project,
 * ignoring case and accents.
 */
export function matchesIssue(issue: RedmineIssue, query: string): boolean {
  const needle = fold(query.trim())
  if (needle === '') return true
  const asId = /^#?(\d+)$/.exec(needle)
  if (asId && Number(asId[1]) === issue.id) return true
  return fold(issue.subject).includes(needle) || fold(issue.project).includes(needle)
}

/** The colour step of a day: 0 without hours, then up to 25 %, 50 % and below 100 % of the target; 4 at the target or over. */
export function summaryLevel(hours: number, target: number): ContributionLevel {
  if (hours <= 0) return 0
  if (target <= 0) return 4
  const ratio = hours / target
  if (ratio <= 0.25) return 1
  if (ratio <= 0.5) return 2
  return ratio < 1 ? 3 : 4
}

/**
 * The month grid of the summary, built by the contributions chart's own `buildGrid`. That grid
 * truncates counts to whole numbers, so the hours go in as hundredths (they have at most two
 * decimals) and come back out as hours in each day's `count`. Its own `level` is relative to the
 * busiest day, so it is replaced by {@link summaryLevel} against the daily `target`.
 */
export function summaryGrid(summary: RedmineSummary, today: string, target: number): ContributionDay[][] {
  const hundredths = new Map(summary.days.map((day) => [day.date, Math.round(day.hours * 100)]))
  return buildGrid(summary.month, hundredths, today).map((week) =>
    week.map((day) => {
      const count = day.count / 100
      return { ...day, count, level: summaryLevel(count, target) }
    }),
  )
}

/**
 * The hours of a row in the issue list: "1,5/8 h" (spent/estimated) when Redmine sends the spent
 * hours, "8 h est." with the estimate alone, "3 h" with the spent hours alone, null with neither.
 */
export function issueHoursText(issue: RedmineIssue, language: Language): string | null {
  const { spentHours: spent, estimatedHours: estimated } = issue
  if (spent !== null && estimated !== null) return `${hoursNumber(spent, language)}/${hoursLong(estimated, language)}`
  if (spent !== null) return hoursLong(spent, language)
  return estimated === null ? null : translate(language, 'redmine.view.estimated', { hours: hoursLong(estimated, language) })
}

/**
 * Hours as typed in the detail's fields: digits with a comma or a point and at most 2 decimals
 * ("1,5", "2.25", ".5"); null for anything else. The range is the caller's.
 */
export function parseHours(text: string): number | null {
  const match = /^(\d*)(?:[.,](\d{1,2}))?$/.exec(text.trim())
  if (!match || (match[1] === '' && match[2] === undefined)) return null
  return Number(`${match[1] === '' ? '0' : match[1]}.${match[2] ?? '0'}`)
}

const WRITE_ERRORS: Readonly<Record<RedmineWriteError, MessageKey>> = {
  auth: 'redmine.error.auth',
  forbidden: 'redmine.error.forbidden',
  'not-found': 'redmine.error.notFound',
  validation: 'redmine.error.validation',
  network: 'redmine.error.network',
  server: 'redmine.error.server',
  'invalid-response': 'redmine.error.server',
}

/** The inline text of a refused write (a validation error shows Redmine's own messages when it sends them). */
export const writeErrorKey = (reason: RedmineWriteError): MessageKey => WRITE_ERRORS[reason]
