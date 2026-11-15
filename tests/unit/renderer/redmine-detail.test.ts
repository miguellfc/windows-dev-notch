import { describe, expect, it } from 'vitest'
import { shownStatus, statusChoices, writeRefusal } from '../../../src/renderer/shared/redmine/detail'
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

describe('shownStatus', () => {
  it("shows the draft only while its write is in flight, else Redmine's status", () => {
    expect(shownStatus(3, true, 2)).toBe(3)
    // After the write (accepted or not) the select shows main's data, never a status Redmine did not apply.
    expect(shownStatus(3, false, 2)).toBe(2)
    expect(shownStatus(null, true, 2)).toBe(2)
    expect(shownStatus(null, false, null)).toBeNull()
  })
})
