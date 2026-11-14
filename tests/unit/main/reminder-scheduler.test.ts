import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RETRY_MS, createReminderScheduler } from '../../../src/main/reminders/reminder-scheduler'
import { createRemindersService, type RemindersService } from '../../../src/main/reminders/reminders-service'
import type { RemindersStore } from '../../../src/main/reminders/reminders-store'
import type { Reminder } from '../../../src/shared/reminders/schema'
import { createMemoryLogger } from '../helpers/memory-logger'

const MAX_TIMEOUT = 2_147_483_647
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const T0 = new Date(2026, 10, 10, 12, 0, 0)

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const reminder = (n: number, dueAt: Date, over: Partial<Reminder> = {}): Reminder => ({
  id: uuid(n),
  text: `secret-text-${n}`,
  dueAt: dueAt.toISOString(),
  repeat: 'none',
  state: 'pending',
  createdAt: T0.toISOString(),
  ...over,
})

function setup(opts: { safetyIntervalMs?: number; noInterval?: boolean; wrapService?: (s: RemindersService) => RemindersService } = {}) {
  // The injected clock follows the fake system time (so it moves in step with the timers); `jump`
  // adds a wall-clock jump on top. Setting it ahead of the timers instead would make a 1 ms
  // re-arm loop fire once per fake millisecond.
  let jumped = 0
  const clock = (): Date => new Date(Date.now() + jumped)
  let items: readonly Reminder[] = []
  let seq = 100
  const store: RemindersStore = {
    load: async () => 'ok',
    all: () => items,
    write: async (next) => {
      items = next
    },
  }
  const real = createRemindersService({
    store,
    now: clock,
    newId: () => uuid(++seq),
    snoozeMinutes: () => 10,
    onChange: () => undefined,
  })
  const service = opts.wrapService ? opts.wrapService(real) : real
  const delays: number[] = []
  const timers = {
    setTimeout: ((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0)
      return setTimeout(fn, ms)
    }) as typeof setTimeout,
    clearTimeout,
    setInterval: (opts.noInterval
      ? () => 0 as unknown as ReturnType<typeof setInterval>
      : setInterval) as typeof setInterval,
    clearInterval: (opts.noInterval ? () => undefined : clearInterval) as typeof clearInterval,
  }
  const fired: Reminder[][] = []
  const missed: Reminder[][] = []
  const logger = createMemoryLogger()
  const scheduler = createReminderScheduler({
    service,
    now: clock,
    timers,
    onFired: (b) => fired.push(b),
    onMissed: (b) => missed.push(b),
    logger,
    ...(opts.safetyIntervalMs !== undefined ? { safetyIntervalMs: opts.safetyIntervalMs } : {}),
  })
  return {
    scheduler,
    service,
    real,
    fired,
    missed,
    delays,
    logger,
    seed: (list: Reminder[]) => {
      items = list
    },
    items: () => items,
    /** Moves the injected clock and the fake timers together. */
    advance: async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms)
    },
    /** Moves only the injected clock (a wall-clock jump, e.g. suspend/resume). */
    jump: (ms: number) => {
      jumped += ms
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('createReminderScheduler', () => {
  it('fires at the due time once, with every due reminder together', async () => {
    const h = setup()
    h.seed([
      reminder(1, new Date(T0.getTime() + 5 * MIN)),
      reminder(2, new Date(T0.getTime() + 5 * MIN)),
      reminder(3, new Date(T0.getTime() + 30 * MIN)),
    ])
    await h.scheduler.start()
    expect(h.delays.at(-1)).toBe(5 * MIN)
    await h.advance(5 * MIN - 1)
    expect(h.fired).toHaveLength(0)
    await h.advance(1)
    expect(h.fired).toHaveLength(1)
    expect(h.fired[0]!.map((r) => r.id).sort()).toEqual([uuid(1), uuid(2)])
    expect(h.fired[0]!.every((r) => r.state === 'due')).toBe(true)
    // Re-armed for the remaining one.
    await h.advance(25 * MIN)
    expect(h.fired).toHaveLength(2)
    expect(h.fired[1]!.map((r) => r.id)).toEqual([uuid(3)])
  })

  it('arms no timer when nothing is pending', async () => {
    const h = setup()
    await h.scheduler.start()
    expect(h.delays).toEqual([])
    expect(vi.getTimerCount()).toBe(1) // only the safety interval
  })

  it('reschedule after adding an earlier reminder moves the timer forward', async () => {
    const h = setup()
    h.seed([reminder(1, new Date(T0.getTime() + 60 * MIN))])
    await h.scheduler.start()
    expect(h.delays.at(-1)).toBe(60 * MIN)
    await h.real.create({ text: 'sooner', preset: '15m' })
    h.scheduler.reschedule()
    expect(h.delays.at(-1)).toBe(15 * MIN)
    await h.advance(15 * MIN)
    expect(h.fired).toHaveLength(1)
    expect(h.fired[0]![0]!.text).toBe('sooner')
  })

  it('reschedule replaces the previous timer instead of stacking', async () => {
    const h = setup()
    h.seed([reminder(1, new Date(T0.getTime() + 60 * MIN))])
    await h.scheduler.start()
    h.scheduler.reschedule()
    h.scheduler.reschedule()
    expect(vi.getTimerCount()).toBe(2) // one timeout + the interval
  })

  it('coalesces resume, timer and interval at the same instant into one onFired', async () => {
    const h = setup()
    h.seed([reminder(1, new Date(T0.getTime() + MIN))])
    await h.scheduler.start()
    h.jump(MIN)
    await Promise.all([h.scheduler.check(), h.scheduler.check(), h.scheduler.check()])
    expect(h.fired).toHaveLength(1)
    // The timers that were also due at that instant add nothing.
    await vi.advanceTimersByTimeAsync(MIN)
    expect(h.fired).toHaveLength(1)
  })

  it('runs exactly one extra pass for a check requested while one is in flight', async () => {
    const calls: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const h = setup({
      wrapService: (s) => ({
        ...s,
        markDue: async () => {
          calls.push('markDue')
          if (calls.length === 1) await gate
          return s.markDue()
        },
      }),
    })
    h.seed([reminder(1, new Date(T0.getTime() - MIN))])
    const a = h.scheduler.check()
    const b = h.scheduler.check()
    const c = h.scheduler.check()
    release()
    await Promise.all([a, b, c])
    expect(calls).toHaveLength(2)
    expect(h.fired).toHaveLength(1)
  })

  it('detects a clock that jumps 2 h ahead through the safety interval', async () => {
    const h = setup()
    h.seed([reminder(1, new Date(T0.getTime() + 30 * MIN))])
    await h.scheduler.start()
    h.jump(2 * HOUR) // wall clock leaps; the fake timeout (30 min) has not fired
    expect(h.fired).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.fired).toHaveLength(1)
    expect(h.fired[0]![0]!.id).toBe(uuid(1))
  })

  it('caps a 40-day timer at 2147483647 ms and re-arms when it fires early', async () => {
    const h = setup({ noInterval: true })
    h.seed([reminder(1, new Date(T0.getTime() + 40 * DAY))])
    await h.scheduler.start()
    expect(h.delays).toEqual([MAX_TIMEOUT])
    await h.advance(MAX_TIMEOUT)
    expect(h.fired).toHaveLength(0)
    expect(h.delays).toEqual([MAX_TIMEOUT, 40 * DAY - MAX_TIMEOUT])
    await h.advance(40 * DAY - MAX_TIMEOUT)
    expect(h.fired).toHaveLength(1)
    expect(h.delays).toEqual([MAX_TIMEOUT, 40 * DAY - MAX_TIMEOUT])
  })

  it('start purges done, reports missed ones, then arms and checks periodically', async () => {
    const h = setup()
    h.seed([
      reminder(1, new Date(T0.getTime() - 3 * HOUR)),
      reminder(2, new Date(T0.getTime() + HOUR)),
      reminder(3, new Date(T0.getTime() - 20 * DAY), {
        state: 'done',
        completedAt: new Date(T0.getTime() - 10 * DAY).toISOString(),
      }),
    ])
    await h.scheduler.start()
    expect(h.items().map((r) => r.id)).not.toContain(uuid(3))
    expect(h.missed).toHaveLength(1)
    expect(h.missed[0]!.map((r) => r.id)).toEqual([uuid(1)])
    expect(h.missed[0]![0]!.state).toBe('missed')
    expect(h.fired).toHaveLength(0)
    expect(h.delays.at(-1)).toBe(HOUR)
  })

  it('does not call onMissed when nothing was missed, and start twice is a no-op', async () => {
    const h = setup()
    h.seed([reminder(1, new Date(T0.getTime() + HOUR))])
    await h.scheduler.start()
    await h.scheduler.start()
    expect(h.missed).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(2)
  })

  it('does not call onFired with an empty batch', async () => {
    const h = setup()
    await h.scheduler.start()
    await h.advance(5 * MIN)
    await h.scheduler.check()
    expect(h.fired).toEqual([])
  })

  it('dispose cancels timers and silences callbacks', async () => {
    const h = setup()
    h.seed([reminder(1, new Date(T0.getTime() + MIN))])
    await h.scheduler.start()
    h.scheduler.dispose()
    expect(vi.getTimerCount()).toBe(0)
    await h.advance(10 * MIN)
    await h.scheduler.check()
    h.scheduler.reschedule()
    expect(h.fired).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('dispose during an in-flight check suppresses onFired and re-arming', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const h = setup({
      wrapService: (s) => ({
        ...s,
        markDue: async () => {
          await gate
          return s.markDue()
        },
      }),
    })
    h.seed([reminder(1, new Date(T0.getTime() - MIN))])
    const p = h.scheduler.check()
    h.scheduler.dispose()
    release()
    await p
    expect(h.fired).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('logs service errors without reminder text and keeps running', async () => {
    let failures = 1
    const h = setup({
      wrapService: (s) => ({
        ...s,
        markDue: async () => {
          if (failures-- > 0) throw new Error('disk full')
          return s.markDue()
        },
      }),
    })
    h.seed([reminder(1, new Date(T0.getTime() + MIN))])
    await h.scheduler.start()
    h.jump(MIN)
    await expect(h.scheduler.check()).resolves.toBeUndefined()
    expect(h.logger.entries.some((e) => e.level === 'error' && e.scope.endsWith(':reminders'))).toBe(true)
    expect(JSON.stringify(h.logger.entries)).not.toContain('secret-text')
    expect(vi.getTimerCount()).toBe(2) // re-armed + interval
    // The overdue reminder is retried after the backoff, not at once.
    expect(h.delays.at(-1)).toBe(RETRY_MS)
    // A check inside the backoff waits for the retry timer instead of writing again.
    await h.scheduler.check()
    expect(h.fired).toEqual([])
    await h.advance(RETRY_MS)
    expect(h.fired).toHaveLength(1)
  })

  it('a persistently failing markDue never re-arms at 0 (no busy loop)', async () => {
    let calls = 0
    const h = setup({
      wrapService: (s) => ({
        ...s,
        markDue: async () => {
          calls++
          throw new Error('EBUSY')
        },
      }),
    })
    h.seed([reminder(1, new Date(T0.getTime() + MIN))])
    await h.scheduler.start()
    expect(h.delays).toEqual([MIN])
    await h.advance(MIN)
    expect(calls).toBe(1)
    expect(h.delays.at(-1)).toBe(RETRY_MS)
    // A mutation elsewhere re-arming the timer still honours the backoff.
    h.scheduler.reschedule()
    expect(h.delays.at(-1)).toBe(RETRY_MS)
    await h.advance(RETRY_MS - 1)
    expect(calls).toBe(1)
    // Over two safety intervals: one attempt per retry or interval tick, never a tight loop.
    await h.advance(2 * 60_000)
    expect(calls).toBeLessThanOrEqual(6)
    expect(h.delays.every((d) => d > 0)).toBe(true)
    expect(h.fired).toEqual([])
  })

  it('a failing purge does not skip the missed sweep; arming and polling continue', async () => {
    const h = setup({
      wrapService: (s) => ({
        ...s,
        purgeDone: async () => {
          throw new Error('boom')
        },
      }),
    })
    h.seed([reminder(1, new Date(T0.getTime() - HOUR)), reminder(2, new Date(T0.getTime() + MIN))])
    await expect(h.scheduler.start()).resolves.toBeUndefined()
    expect(h.logger.entries.some((e) => e.level === 'error')).toBe(true)
    expect(h.missed.map((b) => b.map((r) => r.id))).toEqual([[uuid(1)]])
    await h.advance(MIN)
    expect(h.fired).toHaveLength(1)
  })

  it('a failing missed sweep is logged and start still arms and polls', async () => {
    const h = setup({
      wrapService: (s) => ({
        ...s,
        markMissedOnStart: async () => {
          throw new Error('boom')
        },
      }),
    })
    h.seed([reminder(1, new Date(T0.getTime() + MIN))])
    await expect(h.scheduler.start()).resolves.toBeUndefined()
    expect(h.missed).toEqual([])
    await h.advance(MIN)
    expect(h.fired).toHaveLength(1)
  })
})
