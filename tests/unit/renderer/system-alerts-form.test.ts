import { describe, expect, it } from 'vitest'
import {
  ALERT_RANGES,
  createAlertSaver,
  parseAlertField,
  withAlertChange,
} from '../../../src/renderer/control-center/system-alerts-form'
import {
  DEFAULT_SYSTEM_ALERTS,
  systemAlertSettingsSchema,
  cloneDefaultSystemAlerts,
  type SystemAlertSettings,
} from '../../../src/shared/settings/schema'

describe('ALERT_RANGES', () => {
  it('match the settings schema bounds', () => {
    expect(ALERT_RANGES).toEqual({
      cpuPercent: { min: 50, max: 100 },
      cpuSeconds: { min: 5, max: 300 },
      ramPercent: { min: 50, max: 99 },
      batteryPercent: { min: 5, max: 50 },
      diskFreePercent: { min: 1, max: 50 },
    })
  })
})

describe('parseAlertField', () => {
  const range = { min: 50, max: 100 }
  it.each([
    ['50', 50],
    ['100', 100],
    [' 75 ', 75],
    ['090', 90],
  ])('accepts %j', (raw, value) => expect(parseAlertField(raw, range)).toEqual({ ok: true, value }))

  it.each(['', '  ', '49', '101', '-60', '60.5', '60,5', 'abc', '6e1', '+60', '1e2', '٦٠'])('rejects %j', (raw) =>
    expect(parseAlertField(raw, range)).toEqual({ ok: false }),
  )
})

describe('withAlertChange', () => {
  it('returns a full object with only that field changed, leaving the input untouched', () => {
    const base = cloneDefaultSystemAlerts()
    const next = withAlertChange(base, 'cpu', { sustainSeconds: 45 })
    expect(next.cpu).toEqual({ enabled: true, percent: 90, sustainSeconds: 45 })
    expect(next.ram).toEqual(DEFAULT_SYSTEM_ALERTS.ram)
    expect(base.cpu.sustainSeconds).toBe(30)
    expect(systemAlertSettingsSchema.safeParse(next).success).toBe(true)
  })
})

describe('createAlertSaver', () => {
  /** A fake settings store whose update resolves only when the test says so, like a slow IPC round trip. */
  function harness() {
    let stored: SystemAlertSettings | undefined = cloneDefaultSystemAlerts()
    const sent: SystemAlertSettings[] = []
    const resolvers: (() => void)[] = []
    const send = (alerts: SystemAlertSettings) =>
      new Promise<void>((resolve) => {
        sent.push(alerts)
        resolvers.push(() => {
          stored = alerts
          resolve()
        })
      })
    const saver = createAlertSaver(() => stored, send)
    /** Lets every queued microtask run (a macrotask turn). */
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
    /** The oldest in-flight send succeeds. */
    const answer = async () => {
      await flush()
      resolvers.shift()?.()
      await flush()
    }
    return { saver, sent, answer, flush, store: () => stored, setStore: (next: SystemAlertSettings | undefined) => (stored = next) }
  }

  it('a percent change and an enabled toggle made before the first save lands both persist', async () => {
    const h = harness()
    const fallback = cloneDefaultSystemAlerts()
    const first = h.saver.save('cpu', { percent: 80 }, fallback)
    const second = h.saver.save('cpu', { enabled: false }, fallback)
    await h.flush()
    // Saves are serialized: the second waits for the first.
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.cpu).toEqual({ enabled: true, percent: 80, sustainSeconds: 30 })
    await h.answer()
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]?.cpu).toEqual({ enabled: false, percent: 80, sustainSeconds: 30 })
    await h.answer()
    await Promise.all([first, second])
    expect(h.store()?.cpu).toEqual({ enabled: false, percent: 80, sustainSeconds: 30 })
  })

  it('edits to different alerts in quick succession all persist', async () => {
    const h = harness()
    const fallback = cloneDefaultSystemAlerts()
    void h.saver.save('ram', { percent: 70 }, fallback)
    void h.saver.save('disk', { freePercent: 20 }, fallback)
    void h.saver.save('battery', { enabled: false }, fallback)
    for (let i = 0; i < 3; i++) await h.answer()
    expect(h.store()?.ram.percent).toBe(70)
    expect(h.store()?.disk.freePercent).toBe(20)
    expect(h.store()?.battery.enabled).toBe(false)
  })

  it('once idle, the next save starts from the store again (a change made in another window)', async () => {
    const h = harness()
    const fallback = cloneDefaultSystemAlerts()
    const done = h.saver.save('cpu', { percent: 80 }, fallback)
    await h.answer()
    await done
    const elsewhere = withAlertChange(h.store() ?? fallback, 'ram', { percent: 60 })
    h.setStore(elsewhere)
    void h.saver.save('cpu', { sustainSeconds: 60 }, fallback)
    await h.flush()
    expect(h.sent.at(-1)?.ram.percent).toBe(60)
    expect(h.sent.at(-1)?.cpu).toEqual({ enabled: true, percent: 80, sustainSeconds: 60 })
  })

  it('starts from the fallback before settings load; a failed send does not stop later saves', async () => {
    let calls = 0
    const sent: SystemAlertSettings[] = []
    const saver = createAlertSaver(
      () => undefined,
      async (alerts) => {
        sent.push(alerts)
        if (calls++ === 0) throw new Error('ipc down')
      },
    )
    const fallback = cloneDefaultSystemAlerts()
    await saver.save('ram', { percent: 70 }, fallback)
    await saver.save('ram', { enabled: false }, fallback)
    expect(sent.map((a) => a.ram)).toEqual([
      { enabled: true, percent: 70 },
      // The failed change is not resent: once idle, the next save starts from the store (here, the fallback).
      { enabled: false, percent: 90 },
    ])
  })
})
