import { describe, expect, it } from 'vitest'
import {
  buildGrid,
  classifyGitlabEvent,
  dayStart,
  levelFor,
  localDate,
  localIsoWithOffset,
  monthRange,
  summarize,
  sumTotals,
  weekStart,
  ZERO_TOTALS,
} from '../../../src/shared/code-review/contributions'
import {
  contributionDaySchema,
  contributionsInputSchema,
  contributionSummarySchema,
  contributionTotalsSchema,
  type ContributionDay,
} from '../../../src/shared/code-review/schema'

// tests/unit/setup-tz.ts fixes TZ = Europe/Madrid (CET/CEST) before any module loads.
it('runs with the Europe/Madrid time zone (DST cases depend on it)', () => {
  expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(-60)
  expect(new Date(2026, 6, 15).getTimezoneOffset()).toBe(-120)
})

const inMonth = (weeks: ContributionDay[][]) => weeks.flat().filter((d) => d.inMonth)

describe('localDate / dayStart / weekStart', () => {
  it('formats with local getters, zero-padded', () => {
    expect(localDate(new Date(2026, 0, 5, 0, 0))).toBe('2026-01-05')
    expect(localDate(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31')
  })

  it('puts a GitLab event at 23:30 UTC on the local day (Madrid is ahead of UTC)', () => {
    expect(localDate(new Date('2026-11-12T23:30:00Z'))).toBe('2026-11-13') // CET, +1
    expect(localDate(new Date('2026-07-12T23:30:00Z'))).toBe('2026-07-13') // CEST, +2
    expect(localDate(new Date('2026-11-12T22:30:00Z'))).toBe('2026-11-12') // 23:30 local
    expect(localDate(new Date('2026-11-30T23:30:00Z'))).toBe('2026-12-01') // crosses the month
  })

  it('localIsoWithOffset keeps the local wall time with its UTC offset', () => {
    expect(localIsoWithOffset(new Date(2026, 10, 13))).toBe('2026-11-13T00:00:00+01:00')
    expect(localIsoWithOffset(new Date(2026, 6, 5, 9, 7, 3))).toBe('2026-07-05T09:07:03+02:00')
    const tz = process.env.TZ
    try {
      process.env.TZ = 'America/St_Johns'
      expect(localIsoWithOffset(new Date(2026, 0, 2))).toBe('2026-01-02T00:00:00-03:30')
    } finally {
      process.env.TZ = tz
    }
  })

  it('dayStart is local midnight', () => {
    const d = dayStart(new Date(2026, 10, 13, 17, 45, 12))
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([2026, 10, 13, 0, 0, 0])
  })

  it('weekStart is Monday 00:00 local, also on Monday and Sunday', () => {
    expect(localDate(weekStart(new Date(2026, 10, 13, 10)))).toBe('2026-11-09') // Friday
    expect(localDate(weekStart(new Date(2026, 10, 9, 0, 0)))).toBe('2026-11-09') // Monday 00:00
    expect(localDate(weekStart(new Date(2026, 10, 15, 23, 59)))).toBe('2026-11-09') // Sunday
    expect(weekStart(new Date(2026, 10, 15, 23, 59)).getHours()).toBe(0)
  })

  it('a week that crosses the month starts in the previous month', () => {
    expect(localDate(weekStart(new Date(2026, 11, 2, 9)))).toBe('2026-11-30')
  })

  it('weekStart across the DST change (25 Oct 2026, CEST -> CET) keeps local midnight', () => {
    const w = weekStart(new Date(2026, 9, 25, 23, 30)) // Sunday after the change
    expect(localDate(w)).toBe('2026-10-19')
    expect(w.getHours()).toBe(0)
    const next = weekStart(new Date(2026, 9, 26, 0, 30))
    expect(localDate(next)).toBe('2026-10-26')
    expect(next.getHours()).toBe(0)
  })
})

describe('monthRange', () => {
  it.each([
    [new Date(2026, 1, 10), '2026-02', 28],
    [new Date(2028, 1, 29), '2028-02', 29],
    [new Date(2026, 10, 13), '2026-11', 30],
    [new Date(2026, 11, 31, 23, 59), '2026-12', 31],
  ])('%s -> month %s with %i days', (now, month, days) => {
    const r = monthRange(now)
    expect(r.month).toBe(month)
    expect(localDate(r.from)).toBe(`${month}-01`)
    expect(r.from.getHours()).toBe(0)
    // `to` is the 1st of the next month at 00:00 local (exclusive).
    expect(r.to.getDate()).toBe(1)
    expect(r.to.getHours()).toBe(0)
    const last = new Date(r.to.getFullYear(), r.to.getMonth(), 0)
    expect(last.getDate()).toBe(days)
  })

  it('a month with a DST change is not 24h * days long, but both ends are local midnights', () => {
    const oct = monthRange(new Date(2026, 9, 15))
    expect(oct.to.getTime() - oct.from.getTime()).toBe((31 * 24 + 1) * 3_600_000)
    const mar = monthRange(new Date(2026, 2, 30))
    expect(mar.to.getTime() - mar.from.getTime()).toBe((31 * 24 - 1) * 3_600_000)
    expect(localDate(mar.to)).toBe('2026-04-01')
  })
})

describe('buildGrid', () => {
  const none = new Map<string, number>()

  it('Monday-first columns of 7 days; days outside the month are not in the month', () => {
    const weeks = buildGrid('2026-11', none, '2026-11-13') // 1 Nov 2026 is a Sunday
    expect(weeks).toHaveLength(6)
    for (const w of weeks) expect(w).toHaveLength(7)
    expect(weeks[0]![0]!.date).toBe('2026-10-26')
    expect(weeks[0]!.slice(0, 6).every((d) => !d.inMonth)).toBe(true)
    expect(weeks[0]![6]).toMatchObject({ date: '2026-11-01', inMonth: true })
    expect(weeks[5]![0]).toMatchObject({ date: '2026-11-30', inMonth: true })
    expect(weeks[5]![6]).toMatchObject({ date: '2026-12-06', inMonth: false })
    expect(inMonth(weeks)).toHaveLength(30)
  })

  it('a month that starts on Monday starts the first column on the 1st (5 columns)', () => {
    const weeks = buildGrid('2026-06', none, '2026-06-10') // 1 Jun 2026 is a Monday
    expect(weeks).toHaveLength(5)
    expect(weeks[0]![0]).toMatchObject({ date: '2026-06-01', inMonth: true })
    expect(inMonth(weeks)).toHaveLength(30)
  })

  it('a 28-day February that starts on Monday fills exactly 4 columns', () => {
    const weeks = buildGrid('2027-02', none, '2027-02-10')
    expect(weeks).toHaveLength(4)
    expect(weeks.flat().every((d) => d.inMonth)).toBe(true)
  })

  it.each([
    ['2026-02', 28],
    ['2028-02', 29],
    ['2026-04', 30],
    ['2026-03', 31],
    ['2026-10', 31],
  ])('%s has %i in-month days, consecutive and unique (also across DST)', (month, days) => {
    const weeks = buildGrid(month, none, `${month}-01`)
    const dates = inMonth(weeks).map((d) => d.date)
    expect(dates).toEqual(Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`))
    const all = weeks.flat().map((d) => d.date)
    expect(new Set(all).size).toBe(all.length)
    expect(contributionSummarySchema.shape.weeks.safeParse(weeks).success).toBe(true)
  })

  it('marks future days and ignores counts outside the month', () => {
    const counts = new Map([
      ['2026-10-31', 9],
      ['2026-11-02', 3],
      ['2026-11-13', 1],
    ])
    const days = buildGrid('2026-11', counts, '2026-11-13').flat()
    const byDate = new Map(days.map((d) => [d.date, d]))
    expect(byDate.get('2026-10-31')).toMatchObject({ count: 0, level: 0, inMonth: false })
    expect(byDate.get('2026-11-02')).toMatchObject({ count: 3, level: 4, future: false })
    expect(byDate.get('2026-11-13')).toMatchObject({ count: 1, level: 2, future: false })
    expect(byDate.get('2026-11-14')).toMatchObject({ count: 0, future: true })
  })
})

describe('levelFor', () => {
  it('everything 0 -> level 0', () => {
    expect(levelFor(0, 0)).toBe(0)
    expect(buildGrid('2026-11', new Map(), '2026-11-30').flat().every((d) => d.level === 0)).toBe(true)
  })

  it('a single active day is level 4', () => {
    expect(levelFor(1, 1)).toBe(4)
    const days = buildGrid('2026-11', new Map([['2026-11-05', 2]]), '2026-11-30').flat()
    expect(days.filter((d) => d.level > 0).map((d) => [d.date, d.level])).toEqual([['2026-11-05', 4]])
  })

  it('quartiles of the max; repeated maximums are all level 4', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((c) => levelFor(c, 8))).toEqual([1, 1, 2, 2, 3, 3, 4, 4])
    expect(levelFor(1, 100)).toBe(1)
    const days = buildGrid('2026-11', new Map([['2026-11-03', 6], ['2026-11-04', 6], ['2026-11-05', 1]]), '2026-11-30').flat()
    expect(days.filter((d) => d.level === 4).map((d) => d.date)).toEqual(['2026-11-03', '2026-11-04'])
  })
})

describe('classifyGitlabEvent', () => {
  const base = { contribution: true, commits: 0, opened: false, merged: false, review: false }

  it('pushes count their commit_count', () => {
    expect(classifyGitlabEvent({ action_name: 'pushed to', target_type: null, push_data: { commit_count: 3 } })).toEqual({ ...base, commits: 3 })
    expect(classifyGitlabEvent({ action_name: 'pushed new', push_data: { commit_count: 1 } })).toEqual({ ...base, commits: 1 })
    expect(classifyGitlabEvent({ action_name: 'pushed to' })).toEqual(base)
  })

  it('opened MR, merged MR (accepted or merged)', () => {
    expect(classifyGitlabEvent({ action_name: 'opened', target_type: 'MergeRequest' })).toEqual({ ...base, opened: true })
    expect(classifyGitlabEvent({ action_name: 'accepted', target_type: 'MergeRequest' })).toEqual({ ...base, merged: true })
    expect(classifyGitlabEvent({ action_name: 'merged', target_type: 'MergeRequest' })).toEqual({ ...base, merged: true })
  })

  it('reviews: approvals and comments on MRs', () => {
    expect(classifyGitlabEvent({ action_name: 'approved', target_type: 'MergeRequest' })).toEqual({ ...base, review: true })
    expect(classifyGitlabEvent({ action_name: 'commented on', target_type: 'Note', note: { noteable_type: 'MergeRequest' } })).toEqual({
      ...base,
      review: true,
    })
    expect(classifyGitlabEvent({ action_name: 'commented on', target_type: 'DiffNote', note: { noteable_type: 'MergeRequest' } })).toEqual({
      ...base,
      review: true,
    })
    expect(classifyGitlabEvent({ action_name: 'commented on', target_type: 'DiffNote' })).toEqual({ ...base, review: true })
  })

  it('a comment on an issue or an opened issue is a contribution but no review nor MR', () => {
    expect(classifyGitlabEvent({ action_name: 'commented on', target_type: 'Note', note: { noteable_type: 'Issue' } })).toEqual(base)
    expect(classifyGitlabEvent({ action_name: 'opened', target_type: 'Issue' })).toEqual(base)
    expect(classifyGitlabEvent({ action_name: 'closed', target_type: 'MergeRequest' })).toEqual(base)
  })

  it('joining or leaving a project is not a contribution', () => {
    for (const action_name of ['joined', 'left', 'expired']) {
      expect(classifyGitlabEvent({ action_name, target_type: null }).contribution).toBe(false)
    }
  })

  it('the chart counts only an allowlist, like GitLab’s calendar', () => {
    const counts = (e: Parameters<typeof classifyGitlabEvent>[0]) => classifyGitlabEvent(e).contribution
    for (const target_type of ['MergeRequest', 'Issue', 'WorkItem']) {
      for (const action_name of ['created', 'opened', 'closed', 'merged', 'accepted', 'approved']) {
        expect(counts({ action_name, target_type })).toBe(true)
      }
    }
    expect(counts({ action_name: 'pushed to' })).toBe(true)
    expect(counts({ action_name: 'pushed new', push_data: { commit_count: 0 } })).toBe(true)
    expect(counts({ action_name: 'commented on', target_type: 'Note', note: { noteable_type: 'Commit' } })).toBe(true)
    expect(counts({ action_name: 'updated', target_type: 'WikiPage::Meta' })).toBe(false)
    expect(counts({ action_name: 'created', target_type: 'WikiPage::Meta' })).toBe(false)
    expect(counts({ action_name: 'created', target_type: null })).toBe(false)
    expect(counts({ action_name: 'closed', target_type: 'Milestone' })).toBe(false)
    expect(counts({ action_name: 'deleted', target_type: null })).toBe(false)
    expect(counts({ action_name: 'deleted', target_type: 'MergeRequest' })).toBe(false)
    expect(counts({ action_name: 'reopened', target_type: 'Issue' })).toBe(false)
  })
})

describe('sumTotals / summarize', () => {
  it('sumTotals adds field by field', () => {
    expect(sumTotals()).toEqual(ZERO_TOTALS)
    expect(sumTotals({ commits: 1, opened: 2, merged: 3, reviews: 4 }, { commits: 10, opened: 0, merged: 1, reviews: 0 })).toEqual({
      commits: 11,
      opened: 2,
      merged: 4,
      reviews: 4,
    })
  })

  it('summarize builds a valid summary with monthTotal and activeDays from the grid', () => {
    const now = new Date(2026, 10, 13, 10)
    const totals = { commits: 5, opened: 1, merged: 1, reviews: 2 }
    const s = summarize({
      now,
      counts: new Map([['2026-10-30', 7], ['2026-11-01', 2], ['2026-11-13', 3]]),
      today: totals,
      week: totals,
      monthTotals: totals,
      partial: false,
      restricted: true,
    })
    expect(s.month).toBe('2026-11')
    expect(s.monthTotal).toBe(5)
    expect(s.activeDays).toBe(2)
    expect(s.restricted).toBe(true)
    expect(s.updatedAt).toBe(now.toISOString())
    expect(contributionSummarySchema.parse(s)).toEqual(s)
  })
})

describe('schemas', () => {
  const day = { date: '2026-11-13', count: 2, level: 3, inMonth: true, future: false }
  const totals = { commits: 0, opened: 0, merged: 0, reviews: 0 }

  it('are strict', () => {
    expect(contributionDaySchema.safeParse(day).success).toBe(true)
    expect(contributionDaySchema.safeParse({ ...day, extra: 1 }).success).toBe(false)
    expect(contributionDaySchema.safeParse({ ...day, level: 5 }).success).toBe(false)
    expect(contributionDaySchema.safeParse({ ...day, count: -1 }).success).toBe(false)
    expect(contributionDaySchema.safeParse({ ...day, date: '2026-11-13T00:00' }).success).toBe(false)
    expect(contributionTotalsSchema.safeParse(totals).success).toBe(true)
    expect(contributionTotalsSchema.safeParse({ ...totals, issues: 1 }).success).toBe(false)
    expect(contributionTotalsSchema.safeParse({ ...totals, commits: 1.5 }).success).toBe(false)
    expect(contributionsInputSchema.safeParse({ platform: 'gitlab' }).success).toBe(true)
    expect(contributionsInputSchema.safeParse({ platform: 'gitlab', x: 1 }).success).toBe(false)
    expect(contributionsInputSchema.safeParse({ platform: 'bitbucket' }).success).toBe(false)
  })

  it('summary: weeks of 7 days, 4 to 6 columns, YYYY-MM month', () => {
    const week = Array.from({ length: 7 }, () => day)
    const summary = {
      month: '2026-11',
      weeks: [week, week, week, week, week],
      monthTotal: 0,
      activeDays: 0,
      today: totals,
      week: totals,
      monthTotals: totals,
      partial: false,
      restricted: false,
      updatedAt: '2026-11-13T09:00:00.000Z',
    }
    expect(contributionSummarySchema.safeParse(summary).success).toBe(true)
    expect(contributionSummarySchema.safeParse({ ...summary, weeks: [week, week, week] }).success).toBe(false)
    expect(contributionSummarySchema.safeParse({ ...summary, weeks: Array.from({ length: 7 }, () => week) }).success).toBe(false)
    expect(contributionSummarySchema.safeParse({ ...summary, weeks: [week.slice(1), week, week, week, week] }).success).toBe(false)
    expect(contributionSummarySchema.safeParse({ ...summary, month: '2026-13' }).success).toBe(false)
    expect(contributionSummarySchema.safeParse({ ...summary, extra: true }).success).toBe(false)
  })
})
