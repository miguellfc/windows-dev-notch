import { describe, expect, it } from 'vitest'
import { hoursLong, hoursText, issueHoursText, matchesIssue, parseHours, summaryGrid, summaryLevel, writeErrorKey } from '../../../src/renderer/shared/redmine/format'
import type { RedmineIssue, RedmineSummary } from '../../../src/shared/redmine/schema'

const issue = (over: Partial<RedmineIssue> = {}): RedmineIssue => ({
  id: 123,
  subject: 'Corregir el diseño de la página',
  project: 'Interfaz Web',
  status: { id: 1, name: 'Nueva' },
  estimatedHours: null,
  spentHours: null,
  updatedOn: '2026-11-13T10:00:00Z',
  ...over,
})

describe('hoursText', () => {
  it('uses the language decimal separator, at most 2 decimals and no trailing zeros', () => {
    expect(hoursText(0, 'es')).toBe('0h')
    expect(hoursText(0, 'en')).toBe('0h')
    expect(hoursText(0.25, 'es')).toBe('0,25h')
    expect(hoursText(0.25, 'en')).toBe('0.25h')
    expect(hoursText(5.5, 'es')).toBe('5,5h')
    expect(hoursText(5.5, 'en')).toBe('5.5h')
    expect(hoursText(7.75, 'es')).toBe('7,75h')
    expect(hoursText(8, 'es')).toBe('8h')
    expect(hoursText(23.75, 'es')).toBe('23,75h')
    expect(hoursText(23.75, 'en')).toBe('23.75h')
    expect(hoursText(1.333, 'en')).toBe('1.33h')
  })
})

describe('hoursLong', () => {
  it('spells the unit with a space for labels', () => {
    expect(hoursLong(5.5, 'es')).toBe('5,5 h')
    expect(hoursLong(5.5, 'en')).toBe('5.5 h')
    expect(hoursLong(0, 'es')).toBe('0 h')
    expect(hoursLong(23.75, 'es')).toBe('23,75 h')
  })
})

describe('matchesIssue', () => {
  it('matches everything for an empty query', () => {
    expect(matchesIssue(issue(), '')).toBe(true)
    expect(matchesIssue(issue(), '   ')).toBe(true)
  })

  it('ignores case and accents in the subject and the project', () => {
    expect(matchesIssue(issue(), 'DISENO')).toBe(true)
    expect(matchesIssue(issue(), 'pagina')).toBe(true)
    expect(matchesIssue(issue(), 'interfaz')).toBe(true)
    expect(matchesIssue(issue(), 'diseño')).toBe(true)
    expect(matchesIssue(issue(), 'inexistente')).toBe(false)
  })

  it('matches the exact id with or without #, never a prefix of it', () => {
    expect(matchesIssue(issue({ id: 12, subject: 'x', project: 'y' }), '#12')).toBe(true)
    expect(matchesIssue(issue({ id: 12, subject: 'x', project: 'y' }), '12')).toBe(true)
    expect(matchesIssue(issue({ id: 123, subject: 'x', project: 'y' }), '#12')).toBe(false)
    expect(matchesIssue(issue({ id: 123, subject: 'x', project: 'y' }), '12')).toBe(false)
    expect(matchesIssue(issue({ id: 123, subject: 'x', project: 'y' }), '#123')).toBe(true)
  })

  it('still finds a number inside the subject', () => {
    expect(matchesIssue(issue({ id: 9, subject: 'Versión 2024', project: 'y' }), '2024')).toBe(true)
  })
})

describe('summaryLevel', () => {
  it('is 0 without hours and steps at 25 %, 50 % and the target', () => {
    expect(summaryLevel(0, 8)).toBe(0)
    expect(summaryLevel(0.5, 8)).toBe(1)
    expect(summaryLevel(2, 8)).toBe(1)
    expect(summaryLevel(2.01, 8)).toBe(2)
    expect(summaryLevel(4, 8)).toBe(2)
    expect(summaryLevel(4.01, 8)).toBe(3)
    expect(summaryLevel(7.99, 8)).toBe(3)
    expect(summaryLevel(8, 8)).toBe(4)
    expect(summaryLevel(10, 8)).toBe(4)
  })
})

describe('summaryGrid', () => {
  const summary: RedmineSummary = {
    month: '2026-11',
    days: [
      { date: '2026-11-02', hours: 7.75 },
      { date: '2026-11-03', hours: 0.25 },
    ],
    today: 0.25,
    week: 8,
    monthTotal: 8,
  }

  it('builds the month grid keeping the fractional hours of each day', () => {
    const grid = summaryGrid(summary, '2026-11-03', 8)
    expect(grid.every((week) => week.length === 7)).toBe(true)
    const days = grid.flat()
    expect(days.find((d) => d.date === '2026-11-02')?.count).toBe(7.75)
    expect(days.find((d) => d.date === '2026-11-03')?.count).toBe(0.25)
    expect(days.find((d) => d.date === '2026-11-04')?.future).toBe(true)
    expect(days.find((d) => d.date === '2026-11-03')?.future).toBe(false)
  })

  it('colours each day by its hours against the daily target, not against the busiest day', () => {
    const grid = summaryGrid(
      {
        ...summary,
        days: [
          { date: '2026-11-02', hours: 0.333 },
          { date: '2026-11-03', hours: 7.99 },
          { date: '2026-11-04', hours: 8 },
          { date: '2026-11-05', hours: 3 },
        ],
      },
      '2026-11-10',
      8,
    )
    const level = (date: string) => grid.flat().find((d) => d.date === date)?.level
    expect(level('2026-11-02')).toBe(1)
    expect(level('2026-11-03')).toBe(3)
    expect(level('2026-11-04')).toBe(4)
    expect(level('2026-11-05')).toBe(2)
    expect(level('2026-11-06')).toBe(0)
  })
})

describe('issueHoursText', () => {
  it('shows spent/estimated when Redmine sends the spent hours, else the estimate alone', () => {
    expect(issueHoursText(issue({ spentHours: 1.5, estimatedHours: 8 }), 'es')).toBe('1,5/8 h')
    expect(issueHoursText(issue({ spentHours: 1.5, estimatedHours: 8 }), 'en')).toBe('1.5/8 h')
    expect(issueHoursText(issue({ spentHours: 0, estimatedHours: 2.25 }), 'es')).toBe('0/2,25 h')
    expect(issueHoursText(issue({ spentHours: null, estimatedHours: 8 }), 'es')).toBe('8 h est.')
    expect(issueHoursText(issue({ spentHours: 3, estimatedHours: null }), 'en')).toBe('3 h')
    expect(issueHoursText(issue({ spentHours: null, estimatedHours: null }), 'es')).toBeNull()
  })
})

describe('parseHours', () => {
  it('accepts a comma or a point and at most 2 decimals', () => {
    expect(parseHours('1,5')).toBe(1.5)
    expect(parseHours(' 2.25 ')).toBe(2.25)
    expect(parseHours('8')).toBe(8)
    expect(parseHours('0')).toBe(0)
    expect(parseHours('.5')).toBe(0.5)
  })

  it('rejects anything else', () => {
    for (const text of ['', ' ', '1,234', 'abc', '-1', '1e2', '1.5h', '1,5,5', '0x10']) expect(parseHours(text), text).toBeNull()
  })
})

describe('writeErrorKey', () => {
  it('names each refusal in the form', () => {
    expect(writeErrorKey('forbidden')).toBe('redmine.error.forbidden')
    expect(writeErrorKey('not-found')).toBe('redmine.error.notFound')
    expect(writeErrorKey('validation')).toBe('redmine.error.validation')
    expect(writeErrorKey('auth')).toBe('redmine.error.auth')
    expect(writeErrorKey('network')).toBe('redmine.error.network')
    expect(writeErrorKey('server')).toBe('redmine.error.server')
    expect(writeErrorKey('invalid-response')).toBe('redmine.error.server')
  })
})
