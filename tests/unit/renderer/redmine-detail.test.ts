import { describe, expect, it } from 'vitest'
import { shownStatus, statusChoices, writeRefusal } from '../../../src/renderer/shared/redmine/detail'
import { spentLine } from '../../../src/renderer/shared/redmine/format'
import type { RedmineIssueDetail } from '../../../src/shared/redmine/schema'

const detail = (over: Partial<RedmineIssueDetail> = {}): RedmineIssueDetail => ({
  id: 7,
  subject: 'Tarea',
  project: 'API',
  status: { id: 2, name: 'En curso' },
  estimatedHours: null,
  spentHours: null,
  updatedOn: '2026-11-13T10:00:00Z',
  allowedStatuses: [
    { id: 2, name: 'En curso' },
    { id: 3, name: 'Resuelta' },
  ],
  ...over,
})

describe('writeRefusal', () => {
  it('is null when Redmine accepted the write', () => {
    expect(writeRefusal({ ok: true, data: { ok: true } })).toBeNull()
  })

  it('offers Retry only for transport failures and a failed call', () => {
    expect(writeRefusal({ ok: false })).toEqual({ key: 'redmine.error.failed', messages: [], retryable: true })
    expect(writeRefusal({ ok: true, data: { ok: false, reason: 'network' } })).toEqual({ key: 'redmine.error.network', messages: [], retryable: true })
    expect(writeRefusal({ ok: true, data: { ok: false, reason: 'server' } })?.retryable).toBe(true)
    expect(writeRefusal({ ok: true, data: { ok: false, reason: 'invalid-response' } })?.retryable).toBe(true)
    expect(writeRefusal({ ok: true, data: { ok: false, reason: 'forbidden' } })).toEqual({ key: 'redmine.error.forbidden', messages: [], retryable: false })
    expect(writeRefusal({ ok: true, data: { ok: false, reason: 'not-found' } })?.retryable).toBe(false)
    expect(writeRefusal({ ok: true, data: { ok: false, reason: 'auth' } })?.retryable).toBe(false)
  })

  it("keeps Redmine's validation messages, and only for a validation refusal", () => {
    expect(writeRefusal({ ok: true, data: { ok: false, reason: 'validation', messages: ['Horas no es válido'] } })).toEqual({
      key: 'redmine.error.validation',
      messages: ['Horas no es válido'],
      retryable: false,
    })
    expect(writeRefusal({ ok: true, data: { ok: false, reason: 'validation' } })?.messages).toEqual([])
    expect(writeRefusal({ ok: true, data: { ok: false, reason: 'server', messages: ['x'] } })?.messages).toEqual([])
  })
})

describe('statusChoices', () => {
  it('lists the allowed statuses, adding the current one when Redmine leaves it out', () => {
    expect(statusChoices(detail()).map((s) => s.id)).toEqual([2, 3])
    expect(statusChoices(detail({ allowedStatuses: [{ id: 3, name: 'Resuelta' }] })).map((s) => s.id)).toEqual([2, 3])
  })
})

describe('spentLine', () => {
  it('reads the hours logged against the estimate', () => {
    expect(spentLine(1.5, 6, 'es')).toEqual({ text: '1,5 h imputadas de 6 h', over: false })
    expect(spentLine(1.5, 6, 'en')).toEqual({ text: '1.5 h logged of 6 h', over: false })
  })

  it('reads the hours alone without an estimate, never over', () => {
    expect(spentLine(12.5, null, 'es')).toEqual({ text: '12,5 h imputadas', over: false })
    expect(spentLine(12.5, null, 'en')).toEqual({ text: '12.5 h logged', over: false })
  })

  it('counts no hours read as 0', () => {
    expect(spentLine(null, null, 'es')).toEqual({ text: '0 h imputadas', over: false })
    expect(spentLine(null, 4, 'es')).toEqual({ text: '0 h imputadas de 4 h', over: false })
  })

  it('is over only when the logged hours pass the estimate', () => {
    expect(spentLine(12.5, 6, 'es')).toEqual({ text: '12,5 h imputadas de 6 h', over: true })
    expect(spentLine(6, 6, 'es').over).toBe(false)
    expect(spentLine(0.25, 0, 'es').over).toBe(true)
  })
})

describe('shownStatus', () => {
  it("shows the draft only while its write is in flight, else Redmine's status", () => {
    expect(shownStatus(3, true, 2)).toBe(3)
    // After the write (accepted or not) the select shows main's data, never a status Redmine did not apply.
    expect(shownStatus(3, false, 2)).toBe(2)
    expect(shownStatus(null, true, 2)).toBe(2)
    expect(shownStatus(null, false, null)).toBeNull()
  })
})
