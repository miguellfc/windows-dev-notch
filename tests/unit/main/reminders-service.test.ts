import { describe, expect, it, vi } from 'vitest'
import { createRemindersService } from '../../../src/main/reminders/reminders-service'
import type { RemindersStore } from '../../../src/main/reminders/reminders-store'
import { ExposedIpcError } from '../../../src/main/ipc/errors'
import { REMINDERS_ACTIVE_MAX, type Reminder } from '../../../src/shared/reminders/schema'

const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date =>
  new Date(y, mo - 1, d, h, mi, s)

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function setup(start = local(2026, 11, 10, 12, 0), snooze = 10) {
  let current = start
  let seq = 0
  let items: readonly Reminder[] = []
  const write = vi.fn(async (next: readonly Reminder[]) => {
    items = next
  })
  const store: RemindersStore = {
    load: async () => 'ok',
    all: () => items,
    write,
  }
  const onChange = vi.fn()
  const service = createRemindersService({
    store,
    now: () => current,
    newId: () => uuid(++seq),
    snoozeMinutes: () => snooze,
    onChange,
  })
  return {
    service,
    write,
    onChange,
    seed: (list: Reminder[]) => {
      items = list
    },
    items: () => items,
    setNow: (d: Date) => {
      current = d
    },
  }
}

const reminder = (n: number, over: Partial<Reminder> = {}): Reminder => ({
  id: uuid(n),
  text: `r${n}`,
  dueAt: local(2026, 11, 10, 15, 0).toISOString(),
  repeat: 'none',
  state: 'pending',
  createdAt: local(2026, 11, 1, 9, 0).toISOString(),
  ...over,
})

const iso = (d: Date): string => d.toISOString()

const rejectsWith = async (p: Promise<unknown>, code: string, message?: string) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(ExposedIpcError)
  expect((err as ExposedIpcError).code).toBe(code)
  if (message !== undefined) expect((err as ExposedIpcError).message).toBe(message)
}

describe('create', () => {
  it('parses free-form input and stores a pending reminder', async () => {
    const t = setup()
    const r = await t.service.create({ input: 'en 30 min revisar PR' })
    expect(r).toEqual({
      id: uuid(1),
      text: 'revisar PR',
      dueAt: iso(local(2026, 11, 10, 12, 30)),
      repeat: 'none',
      state: 'pending',
      createdAt: iso(local(2026, 11, 10, 12, 0)),
    })
    expect(t.items()).toEqual([r])
    expect(t.onChange).toHaveBeenCalledTimes(1)
  })

  it('keeps repeat and localTime from a repeating input', async () => {
    const t = setup()
    const r = await t.service.create({ input: 'diario 9:00 standup' })
    expect(r.repeat).toBe('daily')
    expect(r.localTime).toBe('09:00')
    expect(r.dueAt).toBe(iso(local(2026, 11, 11, 9, 0)))
  })

  it.each(['empty-text', 'no-time', 'too-long'] as const)('maps parse error %s to INVALID_INPUT', async (code) => {
    const t = setup()
    const input =
      code === 'empty-text' ? 'en 5 min' : code === 'no-time' ? 'hola' : `en 5 min ${'x'.repeat(201)}`
    await rejectsWith(t.service.create({ input }), 'INVALID_INPUT', code)
    expect(t.write).not.toHaveBeenCalled()
    expect(t.onChange).not.toHaveBeenCalled()
  })

  it('uses presetDueAt for { text, preset }', async () => {
    const t = setup()
    const r = await t.service.create({ text: 'llamar', preset: 'tomorrow-9' })
    expect(r.dueAt).toBe(iso(local(2026, 11, 11, 9, 0)))
    expect(r.state).toBe('pending')
    const r2 = await t.service.create({ text: 'otra', preset: '1h' })
    expect(r2.dueAt).toBe(iso(local(2026, 11, 10, 13, 0)))
  })

  it('rejects control characters with a generic INVALID_INPUT', async () => {
    const t = setup()
    await rejectsWith(t.service.create({ input: 'en 5 min hola\u202Emundo' }), 'INVALID_INPUT')
    expect(t.write).not.toHaveBeenCalled()
  })

  it('accepts emoji ZWJ sequences on both create paths', async () => {
    const t = setup()
    const text = '\u{1F469}\u200D\u{1F4BB} deploy'
    const parsed = await t.service.create({ input: `en 5 min ${text}` })
    expect(parsed.text).toBe(text)
    const preset = await t.service.create({ text, preset: '15m' })
    expect(preset.text).toBe(text)
  })

  it('rejects the 501st non-done reminder but ignores done ones', async () => {
    const t = setup()
    const list = Array.from({ length: REMINDERS_ACTIVE_MAX }, (_, i) => reminder(i + 1))
    t.seed([
      ...list,
      reminder(9000, { state: 'done', completedAt: iso(local(2026, 11, 9)) }),
    ])
    await rejectsWith(t.service.create({ input: 'en 5 min x' }), 'INVALID_INPUT', 'limit')
    t.seed(list.slice(1))
    await expect(t.service.create({ input: 'en 5 min x' })).resolves.toBeDefined()
  })

  describe('{ text, dueAt, repeat } (notch form)', () => {
    it('stores a one-off reminder at the given instant', async () => {
      const t = setup()
      const dueAt = iso(local(2026, 11, 12, 16, 15))
      const r = await t.service.create({ text: ' llamar ', dueAt, repeat: 'none' })
      expect(r).toEqual({
        id: uuid(1),
        text: 'llamar',
        dueAt,
        repeat: 'none',
        state: 'pending',
        createdAt: iso(local(2026, 11, 10, 12, 0)),
      })
    })

    it('rejects a one-off reminder at or before now with REMINDER_PAST_MESSAGE', async () => {
      const t = setup()
      for (const at of [local(2026, 11, 10, 12, 0), local(2026, 11, 10, 11, 59)]) {
        await rejectsWith(
          t.service.create({ text: 'x', dueAt: iso(at), repeat: 'none' }),
          'INVALID_INPUT',
          'dueAt must be in the future',
        )
      }
      expect(t.write).not.toHaveBeenCalled()
    })

    it('daily: keeps the wall-clock time and starts at its next occurrence, ignoring the day', async () => {
      const t = setup()
      // Given a past day at 09:00: the next 09:00 after Tue 10 Nov 12:00 is Wed 11 Nov.
      const r = await t.service.create({ text: 'standup', dueAt: iso(local(2026, 11, 1, 9, 0)), repeat: 'daily' })
      expect(r.repeat).toBe('daily')
      expect(r.localTime).toBe('09:00')
      expect(r.dueAt).toBe(iso(local(2026, 11, 11, 9, 0)))
      // Later today stays today.
      const r2 = await t.service.create({ text: 'café', dueAt: iso(local(2026, 11, 20, 16, 30)), repeat: 'daily' })
      expect(r2.dueAt).toBe(iso(local(2026, 11, 10, 16, 30)))
    })

    it('weekdays: skips the weekend for the first occurrence', async () => {
      // Friday 13 Nov 2026, 18:00: the next weekday 09:00 is Monday 16 Nov.
      const t = setup(local(2026, 11, 13, 18, 0))
      const r = await t.service.create({ text: 'daily sync', dueAt: iso(local(2026, 11, 13, 9, 0)), repeat: 'weekdays' })
      expect(r.localTime).toBe('09:00')
      expect(r.dueAt).toBe(iso(local(2026, 11, 16, 9, 0)))
    })

    it('still enforces the active limit', async () => {
      const t = setup()
      t.seed(Array.from({ length: REMINDERS_ACTIVE_MAX }, (_, i) => reminder(i + 1)))
      await rejectsWith(
        t.service.create({ text: 'x', dueAt: iso(local(2026, 11, 11, 9, 0)), repeat: 'none' }),
        'INVALID_INPUT',
        'limit',
      )
    })
  })

  it('propagates a failed write without calling onChange', async () => {
    const t = setup()
    t.write.mockRejectedValueOnce(new ExposedIpcError('READ_ONLY', 'ro'))
    await rejectsWith(t.service.create({ input: 'en 5 min x' }), 'READ_ONLY')
    expect(t.onChange).not.toHaveBeenCalled()
  })
})

describe('snooze', () => {
  it('sets pending and dueAt = now + snoozeMinutes', async () => {
    const t = setup(local(2026, 11, 10, 12, 0), 15)
    t.seed([reminder(1, { state: 'due', dueAt: iso(local(2026, 11, 10, 11, 0)) })])
    const r = await t.service.snooze(uuid(1))
    expect(r.state).toBe('pending')
    expect(r.dueAt).toBe(iso(local(2026, 11, 10, 12, 15)))
    expect(t.onChange).toHaveBeenCalledTimes(1)
  })

  it('works on missed and pending', async () => {
    const t = setup()
    t.seed([reminder(1, { state: 'missed' }), reminder(2)])
    expect((await t.service.snooze(uuid(1))).state).toBe('pending')
    expect((await t.service.snooze(uuid(2))).dueAt).toBe(iso(local(2026, 11, 10, 12, 10)))
  })

  it('keeps repeat and localTime on a repeating reminder', async () => {
    const t = setup()
    t.seed([reminder(1, { state: 'due', repeat: 'daily', localTime: '09:00' })])
    const r = await t.service.snooze(uuid(1))
    expect(r.repeat).toBe('daily')
    expect(r.localTime).toBe('09:00')
  })

  it('rejects a done reminder', async () => {
    const t = setup()
    t.seed([reminder(1, { state: 'done', completedAt: iso(local(2026, 11, 10, 11)) })])
    await rejectsWith(t.service.snooze(uuid(1)), 'INVALID_INPUT')
  })

  it('NOT_FOUND for an unknown id', async () => {
    await rejectsWith(setup().service.snooze(uuid(77)), 'NOT_FOUND')
  })
})

describe('complete', () => {
  it('marks a one-shot reminder done with completedAt', async () => {
    const t = setup()
    t.seed([reminder(1, { state: 'due' })])
    const r = await t.service.complete(uuid(1))
    expect(r.state).toBe('done')
    expect(r.completedAt).toBe(iso(local(2026, 11, 10, 12, 0)))
  })

  it('moves a repeating reminder to its next occurrence, pending', async () => {
    const t = setup()
    t.seed([reminder(1, { state: 'due', repeat: 'daily', localTime: '09:00', dueAt: iso(local(2026, 11, 10, 9)) })])
    const r = await t.service.complete(uuid(1))
    expect(r.state).toBe('pending')
    expect(r.dueAt).toBe(iso(local(2026, 11, 11, 9, 0)))
    expect(r.completedAt).toBeUndefined()
  })

  it('weekdays on a Friday goes to Monday', async () => {
    const t = setup(local(2026, 11, 13, 10, 0)) // Friday
    t.seed([reminder(1, { state: 'due', repeat: 'weekdays', localTime: '09:00' })])
    expect((await t.service.complete(uuid(1))).dueAt).toBe(iso(local(2026, 11, 16, 9, 0)))
  })

  it('snooze then complete a repeating one uses localTime, not the snoozed time', async () => {
    const t = setup()
    t.seed([reminder(1, { state: 'due', repeat: 'daily', localTime: '09:00', dueAt: iso(local(2026, 11, 10, 9)) })])
    await t.service.snooze(uuid(1)) // dueAt 12:10
    t.setNow(local(2026, 11, 10, 12, 20))
    const r = await t.service.complete(uuid(1))
    expect(r.dueAt).toBe(iso(local(2026, 11, 11, 9, 0)))
  })

  it("completing today's occurrence early skips to tomorrow, not the same time", async () => {
    const t = setup(local(2026, 11, 10, 8, 0))
    t.seed([reminder(1, { repeat: 'daily', localTime: '09:00', dueAt: iso(local(2026, 11, 10, 9)) })])
    expect((await t.service.complete(uuid(1))).dueAt).toBe(iso(local(2026, 11, 11, 9, 0)))
  })

  it('rejects completing a done reminder', async () => {
    const t = setup()
    t.seed([reminder(1, { state: 'done', completedAt: iso(local(2026, 11, 10, 11)) })])
    await rejectsWith(t.service.complete(uuid(1)), 'INVALID_INPUT')
  })

  it('NOT_FOUND for an unknown id', async () => {
    await rejectsWith(setup().service.complete(uuid(77)), 'NOT_FOUND')
  })
})

describe('update', () => {
  it('changes text only', async () => {
    const t = setup()
    t.seed([reminder(1)])
    const r = await t.service.update({ id: uuid(1), text: '  nuevo  ' })
    expect(r.text).toBe('nuevo')
    expect(r.dueAt).toBe(reminder(1).dueAt)
  })

  it('rejects a dueAt <= now', async () => {
    const t = setup()
    t.seed([reminder(1)])
    await rejectsWith(t.service.update({ id: uuid(1), dueAt: iso(local(2026, 11, 10, 12, 0)) }), 'INVALID_INPUT')
    await rejectsWith(t.service.update({ id: uuid(1), dueAt: iso(local(2026, 11, 10, 11, 0)) }), 'INVALID_INPUT')
    expect(t.write).not.toHaveBeenCalled()
  })

  it('setting repeat to daily sets localTime from the resulting dueAt', async () => {
    const t = setup()
    t.seed([reminder(1, { dueAt: iso(local(2026, 11, 10, 15, 45)) })])
    const r = await t.service.update({ id: uuid(1), repeat: 'daily' })
    expect(r.repeat).toBe('daily')
    expect(r.localTime).toBe('15:45')
  })

  it('a new dueAt on a repeating reminder refreshes localTime', async () => {
    const t = setup()
    t.seed([reminder(1, { repeat: 'daily', localTime: '15:00' })])
    const r = await t.service.update({ id: uuid(1), dueAt: iso(local(2026, 11, 11, 8, 30)) })
    expect(r.localTime).toBe('08:30')
  })

  it('repeat none drops localTime', async () => {
    const t = setup()
    t.seed([reminder(1, { repeat: 'daily', localTime: '15:00' })])
    const r = await t.service.update({ id: uuid(1), repeat: 'none' })
    expect(r.repeat).toBe('none')
    expect('localTime' in r).toBe(false)
  })

  it('a text-only update of a repeating reminder keeps localTime', async () => {
    const t = setup()
    t.seed([reminder(1, { repeat: 'daily', localTime: '09:00', dueAt: iso(local(2026, 11, 11, 9)) })])
    expect((await t.service.update({ id: uuid(1), text: 'x' })).localTime).toBe('09:00')
  })

  it('a future dueAt puts a due or missed reminder back to pending', async () => {
    const t = setup()
    t.seed([reminder(1, { state: 'due' }), reminder(2, { state: 'missed' })])
    const future = iso(local(2026, 11, 10, 18))
    expect((await t.service.update({ id: uuid(1), dueAt: future })).state).toBe('pending')
    expect((await t.service.update({ id: uuid(2), dueAt: future })).state).toBe('pending')
  })

  it('a text-only update keeps a due reminder due', async () => {
    const t = setup()
    t.seed([reminder(1, { state: 'due' })])
    expect((await t.service.update({ id: uuid(1), text: 'x' })).state).toBe('due')
  })

  it('rejects updating a done reminder', async () => {
    const t = setup()
    t.seed([reminder(1, { state: 'done', completedAt: iso(local(2026, 11, 10, 11)) })])
    await rejectsWith(t.service.update({ id: uuid(1), text: 'x' }), 'INVALID_INPUT')
  })

  it('rejects text with control characters', async () => {
    const t = setup()
    t.seed([reminder(1)])
    await rejectsWith(t.service.update({ id: uuid(1), text: 'a\u0000b' }), 'INVALID_INPUT')
  })

  it('NOT_FOUND for an unknown id', async () => {
    await rejectsWith(setup().service.update({ id: uuid(77), text: 'x' }), 'NOT_FOUND')
  })
})

describe('remove', () => {
  it('removes the reminder and notifies', async () => {
    const t = setup()
    t.seed([reminder(1), reminder(2)])
    await t.service.remove(uuid(1))
    expect(t.items().map((r) => r.id)).toEqual([uuid(2)])
    expect(t.onChange).toHaveBeenCalledTimes(1)
  })

  it('NOT_FOUND for an unknown id', async () => {
    await rejectsWith(setup().service.remove(uuid(77)), 'NOT_FOUND')
  })
})

describe('markDue', () => {
  it('moves due pending reminders to due and returns only those', async () => {
    const t = setup()
    t.seed([
      reminder(1, { dueAt: iso(local(2026, 11, 10, 11)) }),
      reminder(2, { dueAt: iso(local(2026, 11, 10, 12, 0)) }),
      reminder(3, { dueAt: iso(local(2026, 11, 10, 13)) }),
      reminder(4, { state: 'missed', dueAt: iso(local(2026, 11, 10, 10)) }),
    ])
    const out = await t.service.markDue()
    expect(out.map((r) => r.id)).toEqual([uuid(1), uuid(2)])
    expect(out.every((r) => r.state === 'due')).toBe(true)
    expect(t.items().find((r) => r.id === uuid(3))?.state).toBe('pending')
    expect(t.items().find((r) => r.id === uuid(4))?.state).toBe('missed')
    expect(t.onChange).toHaveBeenCalledTimes(1)
  })

  it('a second immediate call returns [] and does not write', async () => {
    const t = setup()
    t.seed([reminder(1, { dueAt: iso(local(2026, 11, 10, 11)) })])
    await t.service.markDue()
    t.write.mockClear()
    t.onChange.mockClear()
    expect(await t.service.markDue()).toEqual([])
    expect(t.write).not.toHaveBeenCalled()
    expect(t.onChange).not.toHaveBeenCalled()
  })

  it('rolls a due daily forward the next day', async () => {
    const t = setup(local(2026, 11, 10, 9, 0))
    t.seed([reminder(1, { repeat: 'daily', localTime: '09:00', dueAt: iso(local(2026, 11, 10, 9)) })])
    expect((await t.service.markDue()).length).toBe(1)
    expect(t.items()[0]!.state).toBe('due')

    t.setNow(local(2026, 11, 11, 9, 0, 30))
    const out = await t.service.markDue()
    expect(out.map((r) => r.id)).toEqual([uuid(1)])
    expect(out[0]!.state).toBe('due')
    expect(out[0]!.dueAt).toBe(iso(local(2026, 11, 11, 9, 0)))
    expect(await t.service.markDue()).toEqual([])
  })

  it('rolls a missed daily to the latest occurrence <= now', async () => {
    const t = setup(local(2026, 11, 13, 10, 0))
    t.seed([reminder(1, { state: 'missed', repeat: 'daily', localTime: '09:00', dueAt: iso(local(2026, 11, 10, 9)) })])
    const out = await t.service.markDue()
    expect(out[0]!.dueAt).toBe(iso(local(2026, 11, 13, 9, 0)))
    expect(out[0]!.state).toBe('due')
  })

  it('does not roll a due repeating reminder before its next occurrence', async () => {
    const t = setup(local(2026, 11, 10, 20, 0))
    t.seed([reminder(1, { state: 'due', repeat: 'daily', localTime: '09:00', dueAt: iso(local(2026, 11, 10, 9)) })])
    expect(await t.service.markDue()).toEqual([])
  })

  it('a pending repeating reminder is just marked due', async () => {
    const t = setup(local(2026, 11, 13, 10, 0))
    t.seed([reminder(1, { repeat: 'daily', localTime: '09:00', dueAt: iso(local(2026, 11, 10, 9)) })])
    const out = await t.service.markDue()
    expect(out[0]!.state).toBe('due')
    expect(out[0]!.dueAt).toBe(iso(local(2026, 11, 13, 9, 0)))
    expect(await t.service.markDue()).toEqual([])
  })
})

describe('markMissedOnStart', () => {
  it('one-shot overdue becomes missed; future and done are untouched', async () => {
    const t = setup()
    t.seed([
      reminder(1, { dueAt: iso(local(2026, 11, 10, 11)) }),
      reminder(2, { dueAt: iso(local(2026, 11, 10, 13)) }),
      reminder(3, { state: 'done', completedAt: iso(local(2026, 11, 9)), dueAt: iso(local(2026, 11, 9)) }),
      reminder(4, { state: 'due', dueAt: iso(local(2026, 11, 10, 8)) }),
    ])
    const out = await t.service.markMissedOnStart()
    expect(out.map((r) => r.id)).toEqual([uuid(1)])
    expect(out[0]!.state).toBe('missed')
    expect(t.items().find((r) => r.id === uuid(4))?.state).toBe('due')
    expect(t.onChange).toHaveBeenCalledTimes(1)
  })

  it('a daily missed for 3 days yields one missed entry at the latest occurrence', async () => {
    const t = setup(local(2026, 11, 13, 10, 0))
    t.seed([reminder(1, { repeat: 'daily', localTime: '09:00', dueAt: iso(local(2026, 11, 10, 9)) })])
    const out = await t.service.markMissedOnStart()
    expect(out).toHaveLength(1)
    expect(t.items()).toHaveLength(1)
    expect(out[0]!.state).toBe('missed')
    expect(out[0]!.dueAt).toBe(iso(local(2026, 11, 13, 9, 0)))
  })

  it('a repeating overdue by less than a period keeps its dueAt', async () => {
    const t = setup(local(2026, 11, 10, 10, 0))
    t.seed([reminder(1, { repeat: 'daily', localTime: '09:00', dueAt: iso(local(2026, 11, 10, 9)) })])
    const out = await t.service.markMissedOnStart()
    expect(out[0]!.dueAt).toBe(iso(local(2026, 11, 10, 9)))
  })

  it('a daily left due by the last session rolls to today as one missed entry', async () => {
    // Yesterday's 09:00 was left due; today's 09:00 has also passed.
    const t = setup(local(2026, 11, 10, 10, 0))
    t.seed([
      reminder(1, { repeat: 'daily', localTime: '09:00', state: 'due', dueAt: iso(local(2026, 11, 9, 9)) }),
      reminder(2, { repeat: 'daily', localTime: '09:00', state: 'missed', dueAt: iso(local(2026, 11, 8, 9)) }),
    ])
    const out = await t.service.markMissedOnStart()
    expect(out.map((r) => r.id)).toEqual([uuid(1), uuid(2)])
    for (const r of out) {
      expect(r.state).toBe('missed')
      expect(r.dueAt).toBe(iso(local(2026, 11, 10, 9, 0)))
    }
    expect(t.onChange).toHaveBeenCalledTimes(1)
    // Nothing left for the scheduler: no second toast for the same occurrence.
    expect(await t.service.markDue()).toEqual([])
  })

  it('leaves current repeating and one-shot due/missed reminders untouched', async () => {
    const t = setup(local(2026, 11, 10, 10, 0))
    t.seed([
      // Next occurrence (tomorrow 09:00) has not arrived yet.
      reminder(1, { repeat: 'daily', localTime: '09:00', state: 'due', dueAt: iso(local(2026, 11, 10, 9)) }),
      reminder(2, { state: 'missed', dueAt: iso(local(2026, 11, 1, 9)) }),
      reminder(3, { state: 'due', dueAt: iso(local(2026, 11, 2, 9)) }),
    ])
    expect(await t.service.markMissedOnStart()).toEqual([])
    expect(t.write).not.toHaveBeenCalled()
  })

  it('returns [] and does not write when nothing is overdue', async () => {
    const t = setup()
    t.seed([reminder(1)])
    expect(await t.service.markMissedOnStart()).toEqual([])
    expect(t.write).not.toHaveBeenCalled()
  })
})

describe('purgeDone', () => {
  it('removes done reminders completed more than 7 days ago only', async () => {
    const t = setup()
    t.seed([
      reminder(1, { state: 'done', completedAt: iso(local(2026, 11, 2, 11)) }), // 8 days
      reminder(2, { state: 'done', completedAt: iso(local(2026, 11, 3, 12, 0)) }), // exactly 7
      reminder(3, { state: 'done', completedAt: iso(local(2026, 11, 9)) }),
      reminder(4),
    ])
    await t.service.purgeDone()
    expect(t.items().map((r) => r.id)).toEqual([uuid(2), uuid(3), uuid(4)])
    expect(t.onChange).toHaveBeenCalledTimes(1)
  })

  it('does not write when there is nothing to purge', async () => {
    const t = setup()
    t.seed([reminder(1)])
    await t.service.purgeDone()
    expect(t.write).not.toHaveBeenCalled()
  })
})

describe('queries', () => {
  it('list is sorted by dueAt ascending', () => {
    const t = setup()
    t.seed([
      reminder(1, { dueAt: iso(local(2026, 11, 10, 18)) }),
      reminder(2, { dueAt: iso(local(2026, 11, 10, 13)) }),
      reminder(3, { dueAt: iso(local(2026, 11, 10, 15)) }),
    ])
    expect(t.service.list().map((r) => r.id)).toEqual([uuid(2), uuid(3), uuid(1)])
  })

  it('list hides done reminders completed more than 7 days ago', () => {
    const t = setup()
    t.seed([
      reminder(1, { state: 'done', completedAt: iso(local(2026, 11, 2, 11)) }), // 8 days
      reminder(2, { state: 'done', completedAt: iso(local(2026, 11, 3, 12, 0)) }), // exactly 7
      reminder(3, { state: 'done', completedAt: iso(local(2026, 11, 9)) }),
      reminder(4),
    ])
    expect(t.service.list().map((r) => r.id).sort()).toEqual([uuid(2), uuid(3), uuid(4)])
  })

  it('attentionCount counts due and missed', () => {
    const t = setup()
    t.seed([
      reminder(1, { state: 'due' }),
      reminder(2, { state: 'missed' }),
      reminder(3),
      reminder(4, { state: 'done', completedAt: iso(local(2026, 11, 10, 11)) }),
    ])
    expect(t.service.attentionCount()).toBe(2)
  })

  it('nextDueAt is the minimum dueAt among pending, or null', () => {
    const t = setup()
    expect(t.service.nextDueAt()).toBeNull()
    t.seed([
      reminder(1, { dueAt: iso(local(2026, 11, 10, 18)) }),
      reminder(2, { dueAt: iso(local(2026, 11, 10, 14)) }),
      reminder(3, { state: 'due', dueAt: iso(local(2026, 11, 10, 9)) }),
    ])
    expect(t.service.nextDueAt()).toEqual(local(2026, 11, 10, 14))
    t.seed([reminder(3, { state: 'due' })])
    expect(t.service.nextDueAt()).toBeNull()
  })
})

describe('concurrency', () => {
  // Like the real store: items only change once the (queued) write resolves.
  function deferredSetup() {
    let items: readonly Reminder[] = []
    const pending: Array<() => void> = []
    const store: RemindersStore = {
      load: async () => 'ok',
      all: () => items,
      write: (next) =>
        new Promise<void>((resolve) => {
          pending.push(() => {
            items = next
            resolve()
          })
        }),
    }
    let seq = 100
    const service = createRemindersService({
      store,
      now: () => local(2026, 11, 10, 12, 0),
      newId: () => uuid(++seq),
      snoozeMinutes: () => 10,
      onChange: () => undefined,
    })
    const flush = async () => {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setImmediate(r))
        pending.shift()?.()
      }
    }
    return { service, seed: (l: Reminder[]) => (items = l), items: () => items, flush }
  }

  it('create racing markDue keeps both effects', async () => {
    const t = deferredSetup()
    t.seed([reminder(1, { dueAt: iso(local(2026, 11, 10, 11)) })])
    const a = t.service.create({ input: 'en 5 min nuevo' })
    const b = t.service.markDue()
    await t.flush()
    const [created, due] = await Promise.all([a, b])
    expect(due.map((r) => r.id)).toEqual([uuid(1)])
    expect(t.items().map((r) => r.id).sort()).toEqual([uuid(1), created.id].sort())
    expect(t.items().find((r) => r.id === uuid(1))?.state).toBe('due')
  })

  it('snooze(A) and complete(B) both land', async () => {
    const t = deferredSetup()
    t.seed([reminder(1, { state: 'due' }), reminder(2, { state: 'due' })])
    const a = t.service.snooze(uuid(1))
    const b = t.service.complete(uuid(2))
    await t.flush()
    await Promise.all([a, b])
    expect(t.items().find((r) => r.id === uuid(1))?.state).toBe('pending')
    expect(t.items().find((r) => r.id === uuid(2))?.state).toBe('done')
  })

  it('two concurrent creates cannot both pass the limit', async () => {
    const t = deferredSetup()
    t.seed(Array.from({ length: REMINDERS_ACTIVE_MAX - 1 }, (_, i) => reminder(i + 1)))
    const a = t.service.create({ input: 'en 5 min a' }).then(() => 'ok', () => 'err')
    const b = t.service.create({ input: 'en 5 min b' }).then(() => 'ok', () => 'err')
    await t.flush()
    expect((await Promise.all([a, b])).sort()).toEqual(['err', 'ok'])
    expect(t.items()).toHaveLength(REMINDERS_ACTIVE_MAX)
  })

  it('a failed operation does not block the next one', async () => {
    const t = deferredSetup()
    t.seed([reminder(1)])
    const bad = t.service.snooze(uuid(77)).catch((e: unknown) => e)
    const good = t.service.snooze(uuid(1))
    await t.flush()
    expect(await bad).toBeInstanceOf(ExposedIpcError)
    expect((await good).state).toBe('pending')
  })
})
