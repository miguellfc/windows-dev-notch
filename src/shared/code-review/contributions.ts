import type { ContributionDay, ContributionLevel, ContributionSummary, ContributionTotals } from './schema'

/*
 * Pure date helpers for the contributions chart. Everything is in the machine's local time zone:
 * dates are built with local constructors (`new Date(y, m, d)`), so a DST change never adds or
 * drops a day, and day keys are formatted with local getters (never `toISOString()`).
 */

const pad = (n: number): string => String(n).padStart(2, '0')

/** `YYYY-MM-DD` of `d` in local time. */
export const localDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** ISO 8601 of `d` as local wall time with its UTC offset, e.g. `2026-11-13T00:00:00+01:00`. */
export const localIsoWithOffset = (d: Date): string => {
  const offset = -d.getTimezoneOffset()
  const abs = Math.abs(offset)
  const sign = offset >= 0 ? '+' : '-'
  return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** Today at 00:00 local. */
export const dayStart = (now: Date): Date => new Date(now.getFullYear(), now.getMonth(), now.getDate())

/** Monday of `now`'s week at 00:00 local (weeks run Monday -> Sunday). */
export const weekStart = (now: Date): Date => new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7))

/** The current month: `from` = the 1st at 00:00 local, `to` = the 1st of the next month at 00:00 local (exclusive). */
export const monthRange = (now: Date): { from: Date; to: Date; month: string } => ({
  from: new Date(now.getFullYear(), now.getMonth(), 1),
  to: new Date(now.getFullYear(), now.getMonth() + 1, 1),
  month: `${now.getFullYear()}-${pad(now.getMonth() + 1)}`,
})

/** 0 without activity; otherwise the quarter of `max` the count reaches (1-4, the max is always 4). */
export const levelFor = (count: number, max: number): ContributionLevel => {
  if (count <= 0 || max <= 0) return 0
  return Math.min(4, Math.max(1, Math.ceil((count / max) * 4))) as ContributionLevel
}

/**
 * The month chart: columns of 7 days (Monday -> Sunday) from the Monday on or before the 1st to the
 * Sunday on or after the last day (4-6 columns). `counts` is keyed by `YYYY-MM-DD`; keys outside the
 * month are ignored. Days after `today` are `future`.
 */
export const buildGrid = (month: string, counts: ReadonlyMap<string, number>, today: string): ContributionDay[][] => {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number]
  const first = new Date(year, monthNumber - 1, 1)
  const start = weekStart(first)
  const last = new Date(year, monthNumber, 0)
  const lastSunday = new Date(last.getFullYear(), last.getMonth(), last.getDate() + ((7 - last.getDay()) % 7))

  const days: { date: string; count: number; inMonth: boolean }[] = []
  for (let i = 0; ; i++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    const date = localDate(day)
    const inMonth = day.getMonth() === first.getMonth() && day.getFullYear() === year
    days.push({ date, inMonth, count: inMonth ? Math.max(0, Math.trunc(counts.get(date) ?? 0)) : 0 })
    if (date === localDate(lastSunday)) break
  }
  const max = Math.max(0, ...days.map((d) => d.count))
  const weeks: ContributionDay[][] = []
  for (let i = 0; i < days.length; i += 7) {
    weeks.push(days.slice(i, i + 7).map((d) => ({ ...d, level: levelFor(d.count, max), future: d.date > today })))
  }
  return weeks
}

/** The fields of a GitLab event the classification reads. */
export interface GitlabEventLike {
  action_name: string
  target_type?: string | null | undefined
  push_data?: { commit_count?: number | null | undefined } | null | undefined
  note?: { noteable_type?: string | null | undefined } | null | undefined
}

export interface GitlabEventClass {
  /** Counts as one square of the chart (like GitLab's own calendar). */
  contribution: boolean
  commits: number
  opened: boolean
  merged: boolean
  review: boolean
}

/*
 * The chart counts like GitLab's own calendar (an allowlist): pushes, comments, and MR/issue/work
 * item created, closed, merged and approved. Anything else (wiki edits, project created, milestone
 * closed, membership changes, deletions…) is not a contribution.
 */
const PUSH_ACTIONS = new Set(['pushed to', 'pushed new'])
const TARGET_ACTIONS = new Set(['created', 'opened', 'closed', 'merged', 'accepted', 'approved'])
const CONTRIBUTION_TARGETS = new Set(['MergeRequest', 'Issue', 'WorkItem'])

const isContribution = (action: string, targetType: string | null | undefined): boolean =>
  PUSH_ACTIONS.has(action) ||
  action === 'commented on' ||
  (TARGET_ACTIONS.has(action) && typeof targetType === 'string' && CONTRIBUTION_TARGETS.has(targetType))

/**
 * Classifies one GitLab event for the summary: commits from pushes (`commit_count`), MRs opened and
 * merged (`accepted`/`merged`), and reviews (approvals, comments on MRs). A comment on an issue is
 * a contribution but not a review.
 */
export const classifyGitlabEvent = (e: GitlabEventLike): GitlabEventClass => {
  const action = e.action_name
  const onMr = e.target_type === 'MergeRequest'
  const commitCount = e.push_data?.commit_count
  const noteable = e.note?.noteable_type
  const commentOnMr = action === 'commented on' && (noteable === 'MergeRequest' || ((noteable === undefined || noteable === null) && e.target_type === 'DiffNote'))
  return {
    contribution: isContribution(action, e.target_type),
    commits:
      (action === 'pushed to' || action === 'pushed new') && typeof commitCount === 'number' && commitCount > 0 ? Math.trunc(commitCount) : 0,
    opened: action === 'opened' && onMr,
    merged: (action === 'accepted' || action === 'merged') && onMr,
    review: (action === 'approved' && onMr) || commentOnMr,
  }
}

export const ZERO_TOTALS: ContributionTotals = Object.freeze({ commits: 0, opened: 0, merged: 0, reviews: 0 })

/** Field-by-field sum. */
export const sumTotals = (...totals: readonly ContributionTotals[]): ContributionTotals =>
  totals.reduce(
    (acc, t) => ({ commits: acc.commits + t.commits, opened: acc.opened + t.opened, merged: acc.merged + t.merged, reviews: acc.reviews + t.reviews }),
    { ...ZERO_TOTALS },
  )

/** Builds the summary for `now`'s month: grid, month total and active days come from `counts`. */
export const summarize = (input: {
  now: Date
  counts: ReadonlyMap<string, number>
  today: ContributionTotals
  week: ContributionTotals
  monthTotals: ContributionTotals
  partial: boolean
  restricted: boolean
}): ContributionSummary => {
  const { month } = monthRange(input.now)
  const weeks = buildGrid(month, input.counts, localDate(input.now))
  const days = weeks.flat().filter((d) => d.inMonth)
  return {
    month,
    weeks,
    monthTotal: days.reduce((sum, d) => sum + d.count, 0),
    activeDays: days.filter((d) => d.count > 0).length,
    today: { ...input.today },
    week: { ...input.week },
    monthTotals: { ...input.monthTotals },
    partial: input.partial,
    restricted: input.restricted,
    updatedAt: input.now.toISOString(),
  }
}
