import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEndOfDayScheduler, END_OF_DAY_GRACE_MS } from '../../../src/main/redmine/end-of-day'
import type { RedmineAlert } from '../../../src/shared/redmine/schema'
import type { RedmineSettings } from '../../../src/shared/settings/schema'

type Settings = { readonly redmine: RedmineSettings }
const settingsWith = (endOfDay: Partial<RedmineSettings['endOfDay']> = {}, dailyTargetHours = 8): Settings => ({
  redmine: { url: 'https://redmine.example.com', dailyTargetHours, endOfDay: { enabled: true, time: '18:00', sound: true, ...endOfDay } },
})

// 2026-11-16 is a Monday, 2026-11-21 a Saturday, 2026-11-22 a Sunday (local time).
const at = (day: number, h: number, m = 0, s = 0): Date => new Date(2026, 10, day, h, m, s)

interface Setup {
  alerts: RedmineAlert[]
  scheduler: ReturnType<typeof createEndOfDayScheduler>
  change(settings: Settings): void
  hours: { value: number | null }
  connected: { value: boolean }
  /** False while a panel is open: the alert is refused and not shown. */
  accepting: { value: boolean }
  /** Every alert offered, accepted or not. */
  offered: RedmineAlert[]
}

function setup(start: Date, initial: Settings = settingsWith()): Setup {
  vi.setSystemTime(start)
  let current = initial
  const listeners = new Set<(settings: Settings) => void>()
  const alerts: RedmineAlert[] = []
  const hours = { value: 5.5 as number | null }
  const connected = { value: true }
  const accepting = { value: true }
  const offered: RedmineAlert[] = []
  const scheduler = createEndOfDayScheduler({
    settings: {
      get: () => current,
      onChange: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    now: () => new Date(),
    timers: { setTimeout, clearTimeout, setInterval, clearInterval },
    todayHours: () => hours.value,
    isConnected: () => connected.value,
    onAlert: (alert) => {
      offered.push(alert)
      if (!accepting.value) return false
      alerts.push(alert)
      return true
    },
  })
  scheduler.start()
  return {
    alerts,
    scheduler,
    hours,
    connected,
    accepting,
    offered,
    change: (settings) => {
      current = settings
      for (const listener of [...listeners]) listener(settings)
    },
  }
}

const advanceTo = (target: Date) => vi.advanceTimersByTime(target.getTime() - Date.now())

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('end-of-day scheduler', () => {
  it('fires at 18:00:00 and not at 17:59:59, with the hours and the target', () => {
    const { alerts, scheduler } = setup(at(16, 9))
    advanceTo(at(16, 17, 59, 59))
    expect(alerts).toEqual([])
    advanceTo(at(16, 18, 0, 0))
    expect(alerts).toEqual([{ hours: 5.5, target: 8 }])
    scheduler.dispose()
  })

  it('does not fire on Saturday or Sunday', () => {
    const { alerts, scheduler } = setup(at(21, 9))
    advanceTo(at(22, 23, 59))
    expect(alerts).toEqual([])
    scheduler.dispose()
  })

  it('skips the weekend and fires again on Monday', () => {
    const { alerts, scheduler } = setup(at(20, 19)) // Friday, after the time: no alert that day
    advanceTo(at(23, 9))
    expect(alerts).toEqual([])
    advanceTo(at(23, 18, 0, 0))
    expect(alerts).toHaveLength(1)
    scheduler.dispose()
  })

  it.each([
    ['the hours reach the target', (s: Setup) => (s.hours.value = 8)],
    ['the hours pass the target', (s: Setup) => (s.hours.value = 9.25)],
    ['there is no session', (s: Setup) => (s.connected.value = false)],
  ])('does not fire when %s', (_, arrange) => {
    const s = setup(at(16, 9))
    arrange(s)
    advanceTo(at(16, 18, 30))
    expect(s.alerts).toEqual([])
    s.scheduler.dispose()
  })

  it('does not fire when disabled', () => {
    const { alerts, scheduler } = setup(at(16, 9), settingsWith({ enabled: false }))
    advanceTo(at(16, 19))
    expect(alerts).toEqual([])
    scheduler.dispose()
  })

  it('fires once a day, even across the safety interval and explicit checks', () => {
    const { alerts, scheduler } = setup(at(16, 9))
    advanceTo(at(16, 18, 0, 0))
    scheduler.check()
    advanceTo(at(16, 18, 10))
    scheduler.check()
    expect(alerts).toHaveLength(1)
    advanceTo(at(17, 18, 0, 0))
    expect(alerts).toHaveLength(2)
    scheduler.dispose()
  })

  it('does not alert when the app starts after the time', () => {
    const { alerts, scheduler } = setup(at(16, 18, 5))
    scheduler.check()
    advanceTo(at(16, 20))
    expect(alerts).toEqual([])
    advanceTo(at(17, 18, 0, 0))
    expect(alerts).toHaveLength(1)
    scheduler.dispose()
  })

  it('reschedules when the time changes in settings', () => {
    const { alerts, scheduler, change } = setup(at(16, 9))
    change(settingsWith({ time: '17:30' }))
    advanceTo(at(16, 17, 29, 59))
    expect(alerts).toEqual([])
    advanceTo(at(16, 17, 30, 0))
    expect(alerts).toHaveLength(1)
    advanceTo(at(16, 18, 30))
    expect(alerts).toHaveLength(1)
    scheduler.dispose()
  })

  it('a time already passed when it is changed does not fire today', () => {
    const { alerts, scheduler, change } = setup(at(16, 17, 20))
    change(settingsWith({ time: '17:00' }))
    advanceTo(at(16, 20))
    expect(alerts).toEqual([])
    scheduler.dispose()
  })

  it('uses the target from settings', () => {
    const { alerts, scheduler, hours } = setup(at(16, 9), settingsWith({}, 6))
    hours.value = 6
    advanceTo(at(16, 18, 1))
    expect(alerts).toEqual([])
    scheduler.dispose()
    const second = setup(at(17, 9), settingsWith({}, 6))
    second.hours.value = 5
    advanceTo(at(17, 18, 1))
    expect(second.alerts).toEqual([{ hours: 5, target: 6 }])
    second.scheduler.dispose()
  })

  it('waits for the first reading of the hours, then fires', () => {
    const s = setup(at(16, 9))
    s.hours.value = null
    advanceTo(at(16, 18, 0, 30))
    expect(s.alerts).toEqual([])
    s.hours.value = 3
    advanceTo(at(16, 18, 2))
    expect(s.alerts).toEqual([{ hours: 3, target: 8 }])
    s.scheduler.dispose()
  })

  it('catches up on check() after a sleep that skipped the time, within the grace window', () => {
    const s = setup(at(16, 9))
    vi.setSystemTime(at(16, 18, 20)) // resume: timers did not run
    s.scheduler.check()
    expect(s.alerts).toHaveLength(1)
    s.scheduler.dispose()
  })

  it('does not alert long after the time', () => {
    const s = setup(at(16, 9))
    vi.setSystemTime(new Date(at(16, 18).getTime() + END_OF_DAY_GRACE_MS + 1000))
    s.scheduler.check()
    expect(s.alerts).toEqual([])
    s.scheduler.dispose()
  })

  it('keeps a single pending timer (plus the safety interval) however often it checks', () => {
    const { scheduler } = setup(at(16, 9))
    expect(vi.getTimerCount()).toBe(2)
    for (let i = 0; i < 120; i++) {
      vi.advanceTimersByTime(60_000)
      scheduler.check()
      scheduler.check()
    }
    expect(vi.getTimerCount()).toBe(2)
    scheduler.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('alerts once when the session or the hours turn up within the grace window, not after it', () => {
    const s = setup(at(16, 9))
    s.connected.value = false
    advanceTo(at(16, 18, 40))
    expect(s.alerts).toEqual([])
    s.connected.value = true
    advanceTo(at(16, 18, 42))
    expect(s.alerts).toHaveLength(1)
    advanceTo(at(16, 20))
    expect(s.alerts).toHaveLength(1)
    s.scheduler.dispose()

    const late = setup(at(17, 9))
    late.hours.value = null
    advanceTo(at(17, 19, 1))
    late.hours.value = 3
    advanceTo(at(17, 19, 30))
    expect(late.alerts).toEqual([])
    late.scheduler.dispose()
  })

  it('an alert refused with a panel open leaves the day open: it shows once the panel closes, within the grace window', () => {
    const s = setup(at(16, 9))
    s.accepting.value = false
    advanceTo(at(16, 18, 0))
    expect(s.offered).toHaveLength(1)
    expect(s.alerts).toEqual([])
    advanceTo(at(16, 18, 10))
    expect(s.alerts).toEqual([])
    s.accepting.value = true
    advanceTo(at(16, 18, 11))
    expect(s.alerts).toEqual([{ hours: 5.5, target: 8 }])
    const offered = s.offered.length
    advanceTo(at(16, 18, 40))
    expect(s.offered).toHaveLength(offered)
    s.scheduler.dispose()
  })

  it('an alert refused through the whole grace window is given up for the day', () => {
    const s = setup(at(16, 9))
    s.accepting.value = false
    advanceTo(new Date(at(16, 18).getTime() + END_OF_DAY_GRACE_MS + 60_000))
    s.accepting.value = true
    advanceTo(at(16, 21))
    expect(s.alerts).toEqual([])
    // The next weekday alerts as usual.
    advanceTo(at(17, 18))
    expect(s.alerts).toHaveLength(1)
    s.scheduler.dispose()
  })

  it('stops after dispose', () => {
    const { alerts, scheduler } = setup(at(16, 9))
    scheduler.dispose()
    advanceTo(at(16, 19))
    scheduler.check()
    expect(alerts).toEqual([])
  })
})
