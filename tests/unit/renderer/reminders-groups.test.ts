import { describe, expect, it } from 'vitest'
import { buildDueAt } from '../../../src/renderer/shared/reminders/form'
import { groupReminders, isDraftLive, isoToDueFields } from '../../../src/renderer/shared/reminders/groups'
import type { Reminder } from '../../../src/shared/reminders/schema'

const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date => new Date(y, mo - 1, d, h, mi, s)
const NOW = local(2026, 11, 10, 12)

let seq = 0
const make = (over: Partial<Omit<Reminder, 'dueAt'>> & { dueAt: Date }): Reminder => {
  const { dueAt, ...rest } = over
  return {
    id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
    text: `r${seq}`,
    dueAt: dueAt.toISOString(),
    repeat: 'none',
    state: 'pending',
    createdAt: NOW.toISOString(),
    ...rest,
  }
}

describe('groupReminders', () => {
  it('splits into the four groups with the agreed ordering', () => {
    const due2 = make({ state: 'due', dueAt: local(2026, 11, 10, 11) })
    const missed = make({ state: 'missed', dueAt: local(2026, 11, 9, 9) })
    const dueRepeating = make({ state: 'due', repeat: 'daily', localTime: '08:00', dueAt: local(2026, 11, 10, 8) })
    const later = make({ dueAt: local(2026, 11, 12, 9) })
    const soon = make({ dueAt: local(2026, 11, 10, 15) })
    const rep2 = make({ repeat: 'weekdays', localTime: '09:00', dueAt: local(2026, 11, 11, 9) })
    const rep1 = make({ repeat: 'daily', localTime: '08:30', dueAt: local(2026, 11, 10, 20) })
    const doneOld = make({ state: 'done', dueAt: local(2026, 11, 1), completedAt: local(2026, 11, 2).toISOString() })
    const doneA = make({ state: 'done', dueAt: local(2026, 11, 8), completedAt: local(2026, 11, 8, 10).toISOString() })
    const doneB = make({ state: 'done', dueAt: local(2026, 11, 9), completedAt: local(2026, 11, 9, 10).toISOString() })

    const g = groupReminders([later, doneA, rep2, due2, doneOld, soon, missed, rep1, dueRepeating, doneB], NOW)
    expect(g.overdue).toEqual([missed, dueRepeating, due2])
    expect(g.upcoming).toEqual([soon, later])
    expect(g.repeating).toEqual([rep1, rep2])
    expect(g.completed).toEqual([doneB, doneA])
  })

  it('returns empty groups for an empty list', () => {
    expect(groupReminders([], NOW)).toEqual({ overdue: [], upcoming: [], repeating: [], completed: [] })
  })
})

describe('isoToDueFields', () => {
  it('splits an ISO instant into the local date and 24 h time fields (seconds dropped)', () => {
    expect(isoToDueFields(local(2026, 11, 10, 9, 5, 42).toISOString())).toEqual({ date: '2026-11-10', time: '09:05' })
    expect(isoToDueFields(local(2026, 7, 1, 23, 59).toISOString())).toEqual({ date: '2026-07-01', time: '23:59' })
  })

  it('round-trips through the shared form builder', () => {
    const due = local(2026, 3, 28, 22, 30)
    const fields = isoToDueFields(due.toISOString())
    expect(buildDueAt({ day: 'other', ...fields, repeat: 'none' }, NOW)).toEqual({ error: 'past' })
    expect(buildDueAt({ day: 'other', ...fields, repeat: 'none' }, local(2026, 3, 1))).toEqual({ dueAt: due })
  })
})

describe('isDraftLive', () => {
  it('is live only while the reminder exists and is not done', () => {
    const pending = make({ dueAt: local(2026, 11, 11) })
    const due = make({ state: 'due', dueAt: local(2026, 11, 9) })
    const done = make({ state: 'done', dueAt: local(2026, 11, 9) })
    expect(isDraftLive(pending.id, [pending, due, done])).toBe(true)
    expect(isDraftLive(due.id, [pending, due, done])).toBe(true)
    expect(isDraftLive(done.id, [pending, due, done])).toBe(false)
    expect(isDraftLive('missing', [pending])).toBe(false)
    expect(isDraftLive(pending.id, null)).toBe(false)
  })
})
