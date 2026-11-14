import { describe, expect, it } from 'vitest'
import {
  contributionsPhase,
  contributionsText,
  dayCellLabel,
  graphSummaryText,
  gridKeyTarget,
  monthName,
  monthTotalText,
  placeholderGrid,
  shortDate,
  totalText,
  weekdayNames,
} from '../../../src/renderer/shared/code-review/contributions-format'
import { buildGrid } from '../../../src/shared/code-review/contributions'
import type { ContributionDay, ContributionSummary } from '../../../src/shared/code-review/schema'

const day = (patch: Partial<ContributionDay> = {}): ContributionDay => ({ date: '2026-11-12', count: 7, level: 3, inMonth: true, future: false, ...patch })

const summary = (patch: Partial<ContributionSummary> = {}): ContributionSummary => ({
  month: '2026-11',
  weeks: buildGrid('2026-11', new Map([['2026-11-12', 7]]), '2026-11-13'),
  monthTotal: 84,
  activeDays: 15,
  today: { commits: 1, opened: 0, merged: 0, reviews: 2 },
  week: { commits: 5, opened: 1, merged: 1, reviews: 3 },
  monthTotals: { commits: 40, opened: 6, merged: 4, reviews: 12 },
  partial: false,
  restricted: false,
  updatedAt: '2026-11-13T11:00:00.000Z',
  ...patch,
})

describe('contribution counts', () => {
  it('uses the singular for one and the plural otherwise, in both languages', () => {
    expect(contributionsText(1, 'es')).toBe('1 contribución')
    expect(contributionsText(7, 'es')).toBe('7 contribuciones')
    expect(contributionsText(0, 'es')).toBe('0 contribuciones')
    expect(contributionsText(1, 'en')).toBe('1 contribution')
    expect(contributionsText(84, 'en')).toBe('84 contributions')
  })

  it('shows "—" for a missing total and the number otherwise', () => {
    expect(totalText(null)).toBe('—')
    expect(totalText(undefined)).toBe('—')
    expect(totalText(0)).toBe('0')
    expect(totalText(42)).toBe('42')
  })
})

describe('dates and names (Intl)', () => {
  it('names the month locale-aware, capitalised on request', () => {
    expect(monthName('2026-11', 'es')).toBe('noviembre')
    expect(monthName('2026-11', 'es', true)).toBe('Noviembre')
    expect(monthName('2026-02', 'en')).toBe('February')
  })

  it('formats a short day and month', () => {
    expect(shortDate('2026-11-12', 'es')).toBe('12 nov')
    expect(shortDate('2026-11-12', 'en')).toBe('Nov 12')
  })

  it('lists the seven weekdays Monday first (L M X J V S D / M T W T F S S)', () => {
    const es = weekdayNames('es', 'narrow')
    const en = weekdayNames('en', 'narrow')
    expect(es).toHaveLength(7)
    expect([es[0], es[2], es[4]]).toEqual(['L', 'X', 'V'])
    expect([en[0], en[2], en[4]]).toEqual(['M', 'W', 'F'])
    expect(weekdayNames('es', 'long')[0]).toBe('lunes')
    expect(weekdayNames('en', 'long')[6]).toBe('Sunday')
  })
})

describe('labels', () => {
  it('labels a day with its date and count; a future day only with its date', () => {
    expect(dayCellLabel(day(), 'es')).toBe('12 nov · 7 contribuciones')
    expect(dayCellLabel(day({ count: 1, level: 4 }), 'es')).toBe('12 nov · 1 contribución')
    expect(dayCellLabel(day({ count: 0, level: 0 }), 'en')).toBe('Nov 12 · 0 contributions')
    expect(dayCellLabel(day({ date: '2026-11-20', count: 0, level: 0, future: true }), 'es')).toBe('20 nov')
  })

  it('writes the month total and the screen-reader summary', () => {
    expect(monthTotalText(summary(), 'es')).toBe('84 contribuciones en el gráfico de noviembre')
    expect(monthTotalText(summary({ monthTotal: 1 }), 'en')).toBe("1 contribution in November's chart")
    expect(graphSummaryText(summary(), 'es')).toBe('Noviembre: 84 contribuciones en 15 días activos')
    expect(graphSummaryText(summary({ monthTotal: 1, activeDays: 1 }), 'es')).toBe('Noviembre: 1 contribución en 1 día activo')
    expect(graphSummaryText(summary(), 'en')).toBe('November: 84 contributions on 15 active days')
  })
})

describe('contributionsPhase', () => {
  it('loads until a summary arrives, shows the error without one, and keeps the last data with the error', () => {
    expect(contributionsPhase(undefined)).toEqual({ phase: 'loading', summary: null, error: false })
    expect(contributionsPhase({ summary: null, error: false })).toEqual({ phase: 'loading', summary: null, error: false })
    expect(contributionsPhase({ summary: null, error: true })).toEqual({ phase: 'error', summary: null, error: true })
    const s = summary()
    expect(contributionsPhase({ summary: s, error: false })).toEqual({ phase: 'ready', summary: s, error: false })
    expect(contributionsPhase({ summary: s, error: true })).toEqual({ phase: 'ready', summary: s, error: true })
  })
})

describe('placeholderGrid', () => {
  it('is the current month, every day at level 0', () => {
    const weeks = placeholderGrid(new Date(2026, 10, 13, 10))
    expect(weeks).toHaveLength(6)
    expect(weeks.flat().every((d) => d.level === 0 && d.count === 0)).toBe(true)
    expect(weeks.flat().filter((d) => d.inMonth)).toHaveLength(30)
  })
})

describe('gridKeyTarget', () => {
  // November 2026: Sunday the 1st, so the first column holds only the 1st (row 6).
  const weeks = buildGrid('2026-11', new Map(), '2026-11-13')
  // February 2027: Monday the 1st, 4 full columns.
  const feb = buildGrid('2027-02', new Map(), '2027-02-10')

  it('moves by a day with up/down and by a week with left/right', () => {
    expect(gridKeyTarget(weeks, '2026-11-12', 'ArrowDown')).toBe('2026-11-13')
    expect(gridKeyTarget(weeks, '2026-11-12', 'ArrowUp')).toBe('2026-11-11')
    expect(gridKeyTarget(weeks, '2026-11-12', 'ArrowRight')).toBe('2026-11-19')
    expect(gridKeyTarget(weeks, '2026-11-12', 'ArrowLeft')).toBe('2026-11-05')
    // Sunday → Monday of the next column.
    expect(gridKeyTarget(weeks, '2026-11-01', 'ArrowDown')).toBe('2026-11-02')
  })

  it('stays inside the month', () => {
    expect(gridKeyTarget(weeks, '2026-11-01', 'ArrowUp')).toBeNull()
    expect(gridKeyTarget(weeks, '2026-11-03', 'ArrowLeft')).toBeNull()
    expect(gridKeyTarget(weeks, '2026-11-30', 'ArrowDown')).toBeNull()
    expect(gridKeyTarget(weeks, '2026-11-26', 'ArrowRight')).toBeNull()
    expect(gridKeyTarget(feb, '2027-02-28', 'ArrowDown')).toBeNull()
  })

  it('Home/End go to the first/last day of the month on the same weekday row', () => {
    expect(gridKeyTarget(weeks, '2026-11-18', 'Home')).toBe('2026-11-04')
    expect(gridKeyTarget(weeks, '2026-11-18', 'End')).toBe('2026-11-25')
    expect(gridKeyTarget(weeks, '2026-11-15', 'Home')).toBe('2026-11-01')
    expect(gridKeyTarget(weeks, '2026-11-15', 'End')).toBe('2026-11-29')
    expect(gridKeyTarget(feb, '2027-02-10', 'End')).toBe('2027-02-24')
  })

  it('ignores other keys and unknown dates', () => {
    expect(gridKeyTarget(weeks, '2026-11-12', 'Enter')).toBeNull()
    expect(gridKeyTarget(weeks, '2026-10-30', 'ArrowDown')).toBeNull()
  })
})
