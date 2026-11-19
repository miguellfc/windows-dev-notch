import { describe, expect, it } from 'vitest'
import type { RedmineIssue, RedmineSummary } from '../../../src/shared/redmine/schema'
import { summaryLine } from '../../../src/renderer/shared/redmine/format'
import { redmineSearch, searchStep, type LookupState } from '../../../src/renderer/shared/redmine/search'

const issue = (id: number, subject = `Tarea ${'x'.repeat(3)}`, project = 'Portal'): RedmineIssue => ({
  id,
  subject,
  project,
  status: { id: 1, name: 'Nueva' },
  estimatedHours: null,
  spentHours: null,
  updatedOn: '2026-11-18T10:00:00Z',
})

describe('redmineSearch', () => {
  const issues = [issue(412, 'Diseño de la pantalla'), issue(41, 'Corregir vacaciones'), issue(7, 'Migrar datos')]

  it('is idle with an empty query or only spaces', () => {
    expect(redmineSearch('', issues)).toEqual({ kind: 'idle' })
    expect(redmineSearch('   ', issues)).toEqual({ kind: 'idle' })
  })

  it('finds a listed issue by its number, with or without #', () => {
    expect(redmineSearch('#412', issues)).toEqual({ kind: 'one', id: 412 })
    expect(redmineSearch('412', issues)).toEqual({ kind: 'one', id: 412 })
    expect(redmineSearch('  #412 ', issues)).toEqual({ kind: 'one', id: 412 })
  })

  it('prefers the exact id over issues that carry the number in their text', () => {
    const mixed = [issue(412, 'La tarea'), issue(5, 'Error 412 al guardar'), issue(6, 'Otro 412')]
    expect(redmineSearch('412', mixed)).toEqual({ kind: 'one', id: 412 })
  })

  it('looks up a number outside the list', () => {
    expect(redmineSearch('#9999', issues)).toEqual({ kind: 'lookup', id: 9999 })
    expect(redmineSearch('9999', issues)).toEqual({ kind: 'lookup', id: 9999 })
    expect(redmineSearch('#9999', [])).toEqual({ kind: 'lookup', id: 9999 })
  })

  it('never looks up a number no issue can have', () => {
    expect(redmineSearch('#0', issues)).toEqual({ kind: 'none' })
    expect(redmineSearch('#99999999999999999999', issues)).toEqual({ kind: 'none' })
  })

  it('ignores case and accents', () => {
    expect(redmineSearch('DISEÑO', issues)).toEqual({ kind: 'one', id: 412 })
    expect(redmineSearch('diseno', issues)).toEqual(redmineSearch('DISEÑO', issues))
  })

  it('shows at most 5 of many matches and counts the rest', () => {
    const seven = [1, 2, 3, 4, 5, 6, 7].map((id) => issue(id, 'Informe mensual'))
    const result = redmineSearch('informe', seven)
    expect(result.kind).toBe('many')
    if (result.kind !== 'many') return
    expect(result.issues.map((row) => row.id)).toEqual([1, 2, 3, 4, 5])
    expect(result.more).toBe(2)
  })

  it('has nothing more to count with 5 matches or fewer', () => {
    const two = [issue(1, 'Informe'), issue(2, 'Informe')]
    expect(redmineSearch('informe', two)).toEqual({ kind: 'many', issues: two, more: 0 })
  })

  it('answers none when no text matches', () => {
    expect(redmineSearch('zzz', issues)).toEqual({ kind: 'none' })
  })
})

describe('searchStep', () => {
  const asking412: LookupState = searchStep({ phase: 'idle' }, { type: 'query', id: 412 })

  it('asks for the last number typed', () => {
    expect(asking412).toEqual({ phase: 'searching', id: 412 })
  })

  it('ignores the answer of an earlier number', () => {
    const asking41 = searchStep({ phase: 'idle' }, { type: 'query', id: 41 })
    const asking = searchStep(asking41, { type: 'query', id: 412 })
    expect(searchStep(asking, { type: 'answer', id: 41, found: true })).toEqual({ phase: 'searching', id: 412 })
    expect(searchStep(asking, { type: 'failed', id: 41 })).toEqual({ phase: 'searching', id: 412 })
  })

  it('applies the answer of the last number', () => {
    expect(searchStep(asking412, { type: 'answer', id: 412, found: true })).toEqual({ phase: 'found', id: 412 })
    expect(searchStep(asking412, { type: 'answer', id: 412, found: false })).toEqual({ phase: 'missing', id: 412 })
  })

  it('keeps a failure apart from "no match"', () => {
    expect(searchStep(asking412, { type: 'failed', id: 412 })).toEqual({ phase: 'failed', id: 412 })
  })

  it('drops an answer that arrives once the search is cleared', () => {
    const cleared = searchStep(asking412, { type: 'clear' })
    expect(cleared).toEqual({ phase: 'idle' })
    expect(searchStep(cleared, { type: 'answer', id: 412, found: true })).toEqual({ phase: 'idle' })
  })

  it('does not let a repeated answer overwrite the one applied', () => {
    const found = searchStep(asking412, { type: 'answer', id: 412, found: true })
    expect(searchStep(found, { type: 'failed', id: 412 })).toEqual(found)
  })
})

describe('summaryLine', () => {
  const summary: RedmineSummary = { month: '2026-11', days: [], today: 5.5, week: 21, monthTotal: 38.5 }

  it('compresses the summary into one line in Spanish', () => {
    expect(summaryLine(summary, 'es')).toBe('Hoy 5,5H · Semana 21H · Mes 38,5H')
  })

  it('compresses the summary into one line in English', () => {
    expect(summaryLine(summary, 'en')).toBe('Today 5.5H · Week 21H · Month 38.5H')
  })

  it('shows a dash for each figure until the summary arrives', () => {
    expect(summaryLine(null, 'es')).toBe('Hoy — · Semana — · Mes —')
  })
})
