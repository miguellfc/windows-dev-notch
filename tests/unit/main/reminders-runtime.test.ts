import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRemindersIpcHandlers } from '../../../src/main/reminders/reminders-ipc'
import { createRemindersRuntime, type RemindersSnapshot } from '../../../src/main/reminders/reminders-runtime'
import type { RemindersLoadResult, RemindersStore } from '../../../src/main/reminders/reminders-store'
import type { UsageEvent } from '../../../src/main/services/usage-log'
import type { Reminder } from '../../../src/shared/reminders/schema'
import { createMemoryLogger } from '../helpers/memory-logger'

const MIN = 60_000
const T0 = new Date('2026-11-10T11:00:00.000Z')
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const reminder = (n: number, dueAt: Date, over: Partial<Reminder> = {}): Reminder => ({
  id: uuid(n),
  text: `secret-text-${n}`,
  dueAt: dueAt.toISOString(),
  repeat: 'none',
  state: 'pending',
  createdAt: new Date(T0.getTime() - 60 * MIN).toISOString(),
  ...over,
})

function setup(opts: { load?: RemindersLoadResult; seed?: Reminder[]; loadGate?: Promise<void> } = {}) {
  let current = T0
  let items: readonly Reminder[] = opts.seed ?? []
  let seq = 100
  let snoozeMinutes = 10
  const store: RemindersStore = {
    load: async () => {
      await opts.loadGate
      return opts.load ?? 'ok'
    },
    all: () => items,
    write: async (next) => {
      items = next
    },
  }
  const delays: number[] = []
  const timers = {
    setTimeout: ((_fn: () => void, ms?: number) => {
      delays.push(ms ?? 0)
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
    setInterval: (() => 0 as unknown as ReturnType<typeof setInterval>) as typeof setInterval,
    clearInterval: (() => undefined) as typeof clearInterval,
  }
  const toast = { fired: vi.fn<(batch: Reminder[]) => void>(), missed: vi.fn<(count: number) => void>() }
  const setDue = vi.fn<(due: boolean) => void>()
  const emitChanged = vi.fn<(snapshot: RemindersSnapshot) => void>()
  const emitFired = vi.fn<(count: number) => void>()
  const recordUsage = vi.fn<(event: UsageEvent) => void>()
  const logger = createMemoryLogger()
  const runtime = createRemindersRuntime({
    store,
    now: () => current,
    newId: () => uuid(++seq),
    snoozeMinutes: () => snoozeMinutes,
    timers,
    logger,
    toast,
    setDue,
    emitChanged,
    emitFired,
    recordUsage,
  })
  return {
    recordUsage,
    runtime,
    toast,
    setDue,
    emitChanged,
    emitFired,
    delays,
    logger,
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms)
    },
    setSnooze: (m: number) => {
      snoozeMinutes = m
    },
  }
}

describe('reminders runtime', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each([
    ['ok', null],
    ['quarantined', 'quarantined'],
    ['read-only', 'read-only'],
  ] as const)('maps a %s load to notice %s', async (load, notice) => {
    const { runtime, emitChanged } = setup({ load })
    await runtime.start()
    expect(runtime.snapshot().notice).toBe(notice)
    expect(emitChanged).toHaveBeenLastCalledWith({ reminders: [], notice })
  })

  it('publishes the initial state after start without toasts when nothing is overdue', async () => {
    const future = reminder(1, new Date(T0.getTime() + 30 * MIN))
    const { runtime, setDue, emitChanged, toast, emitFired, delays } = setup({ seed: [future] })
    await runtime.start()
    expect(setDue).toHaveBeenLastCalledWith(false)
    expect(emitChanged).toHaveBeenLastCalledWith({ reminders: [future], notice: null })
    expect(toast.fired).not.toHaveBeenCalled()
    expect(toast.missed).not.toHaveBeenCalled()
    expect(emitFired).not.toHaveBeenCalled()
    expect(delays.at(-1)).toBe(30 * MIN)
  })

  it('reports reminders missed while the app was closed with one toast and one chime', async () => {
    const seed = [reminder(1, new Date(T0.getTime() - 2 * 60 * MIN)), reminder(2, new Date(T0.getTime() - 60 * MIN))]
    const { runtime, toast, emitFired, setDue, emitChanged } = setup({ seed })
    await runtime.start()
    expect(toast.missed).toHaveBeenCalledTimes(1)
    expect(toast.missed).toHaveBeenCalledWith(2)
    expect(emitFired).toHaveBeenCalledTimes(1)
    expect(emitFired).toHaveBeenCalledWith(2)
    expect(setDue).toHaveBeenLastCalledWith(true)
    expect(emitChanged.mock.lastCall![0].reminders.map((r) => r.state)).toEqual(['missed', 'missed'])
  })

  it('records missed, fired and completed reminders in the usage log', async () => {
    const seed = [
      reminder(1, new Date(T0.getTime() - 60 * MIN)),
      reminder(2, new Date(T0.getTime() + 5 * MIN)),
      reminder(3, new Date(T0.getTime() + 6 * MIN)),
    ]
    const { runtime, recordUsage, advance } = setup({ seed })
    await runtime.start()
    expect(recordUsage.mock.calls).toEqual([[{ type: 'reminders-missed', count: 1 }]])
    advance(10 * MIN)
    await runtime.check()
    expect(recordUsage).toHaveBeenLastCalledWith({ type: 'reminders-fired', count: 2 })
    await runtime.service.complete(uuid(2))
    expect(recordUsage).toHaveBeenLastCalledWith({ type: 'reminder-completed' })
    // A refused completion (already done) is not counted.
    await expect(runtime.service.complete(uuid(2))).rejects.toThrow()
    expect(recordUsage).toHaveBeenCalledTimes(3)
  })

  it('after a create: publishes, keeps due off and aims the timer at the new reminder', async () => {
    const { runtime, setDue, emitChanged, delays } = setup()
    await runtime.start()
    setDue.mockClear()
    emitChanged.mockClear()
    const created = await runtime.service.create({ text: 'Revisar PR', preset: '15m' })
    expect(setDue).toHaveBeenCalledWith(false)
    expect(emitChanged).toHaveBeenLastCalledWith({ reminders: [created], notice: null })
    expect(delays.at(-1)).toBe(15 * MIN)
  })

  it('fires a batch on check: toast, chime and due on', async () => {
    const seed = [reminder(1, new Date(T0.getTime() + 5 * MIN)), reminder(2, new Date(T0.getTime() + 6 * MIN))]
    const { runtime, toast, emitFired, setDue, advance } = setup({ seed })
    await runtime.start()
    advance(10 * MIN)
    await runtime.check()
    expect(toast.fired).toHaveBeenCalledTimes(1)
    expect(toast.fired.mock.lastCall![0].map((r) => r.id)).toEqual([uuid(1), uuid(2)])
    expect(emitFired).toHaveBeenCalledWith(2)
    expect(setDue).toHaveBeenLastCalledWith(true)
  })

  it('snoozing with the live setting turns due off and moves the timer', async () => {
    const seed = [reminder(1, new Date(T0.getTime() + 5 * MIN))]
    const { runtime, setDue, delays, advance, setSnooze } = setup({ seed })
    await runtime.start()
    advance(5 * MIN)
    await runtime.check()
    expect(setDue).toHaveBeenLastCalledWith(true)
    setSnooze(30)
    await runtime.service.snooze(uuid(1))
    expect(setDue).toHaveBeenLastCalledWith(false)
    expect(delays.at(-1)).toBe(30 * MIN)
  })

  it('stops reacting after dispose', async () => {
    const seed = [reminder(1, new Date(T0.getTime() + 5 * MIN))]
    const { runtime, toast, advance } = setup({ seed })
    await runtime.start()
    runtime.dispose()
    advance(10 * MIN)
    await runtime.check()
    expect(toast.fired).not.toHaveBeenCalled()
  })

  it('never logs reminder text', async () => {
    const seed = [reminder(1, new Date(T0.getTime() - MIN)), reminder(2, new Date(T0.getTime() + MIN))]
    const { runtime, logger, advance } = setup({ seed })
    await runtime.start()
    advance(2 * MIN)
    await runtime.check()
    expect(JSON.stringify(logger.entries)).not.toContain('secret-text')
  })

  it('IPC calls made before start finishes wait for the loaded store', async () => {
    let openGate: () => void = () => undefined
    const loadGate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    const future = reminder(1, new Date(T0.getTime() + 30 * MIN))
    const { runtime } = setup({ seed: [future], load: 'quarantined', loadGate })
    const handlers = createRemindersIpcHandlers(runtime.service, runtime.snapshot, runtime.ready)

    const starting = runtime.start()
    const list = Promise.resolve(handlers['reminders:list'](undefined))
    const created = Promise.resolve(handlers['reminders:create']({ text: 'Otro', preset: '1h' }))
    let settled = false
    void list.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    openGate()
    await starting
    // Mutations run after the load too, so the early list sees the file and the notice.
    await expect(list).resolves.toEqual({ reminders: [future], notice: 'quarantined' })
    await expect(created).resolves.toMatchObject({ text: 'Otro' })
    expect(runtime.snapshot().reminders).toHaveLength(2)
  })

  it('ready resolves even when start fails', async () => {
    const failing = createRemindersRuntime({
      store: { load: async () => Promise.reject(new Error('disk')), all: () => [], write: async () => undefined },
      now: () => T0,
      newId: () => uuid(1),
      snoozeMinutes: () => 10,
      timers: { setTimeout, clearTimeout, setInterval, clearInterval },
      logger: createMemoryLogger(),
      toast: { fired: () => undefined, missed: () => undefined },
      setDue: () => undefined,
      emitChanged: () => undefined,
      emitFired: () => undefined,
    })
    await expect(failing.start()).rejects.toThrow('disk')
    await expect(failing.ready()).resolves.toBeUndefined()
    failing.dispose()
  })

  it('a throwing publish does not fail a change that was saved', async () => {
    const { runtime, setDue, logger } = setup()
    await runtime.start()
    setDue.mockImplementation(() => {
      throw new Error('window gone secret-text-x')
    })
    await expect(runtime.service.create({ text: 'secret-text-9', preset: '15m' })).resolves.toMatchObject({ text: 'secret-text-9' })
    expect(runtime.snapshot().reminders).toHaveLength(1)
    expect(logger.entries.some((e) => e.level === 'error' && e.message === 'Publishing reminders failed')).toBe(true)
    expect(JSON.stringify(logger.entries)).not.toContain('secret-text')
  })
})
