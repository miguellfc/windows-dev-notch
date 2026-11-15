import { describe, expect, it } from 'vitest'
import { createRedmineUpdater, type RedminePatch, type RedmineSettings } from '../../../src/renderer/control-center/redmine-settings-patch'

const settings = (): RedmineSettings => ({ url: 'https://redmine.example.com', dailyTargetHours: 8, endOfDay: { enabled: true, time: '18:00', sound: true } })

describe('createRedmineUpdater', () => {
  it('serializes patches: each one is built from the block the previous one left', async () => {
    let stored = settings()
    const sent: RedminePatch[] = []
    const update = createRedmineUpdater(
      () => stored,
      async ({ redmine }) => {
        sent.push(redmine)
        await new Promise((resolve) => setTimeout(resolve, 10))
        stored = { ...stored, ...redmine } // the store only changes once the IPC resolves
        return { ok: true }
      },
    )
    const first = update((r) => ({ ...r, endOfDay: { ...r.endOfDay, enabled: false } }))
    const second = update((r) => ({ ...r, endOfDay: { ...r.endOfDay, sound: false } }))
    await Promise.all([first, second])
    expect(sent[1]?.endOfDay).toEqual({ enabled: false, time: '18:00', sound: false })
  })

  it('keeps endOfDay when only the target changes, and never sends the url main owns', async () => {
    let stored = settings()
    const sent: RedminePatch[] = []
    const update = createRedmineUpdater(
      () => stored,
      async ({ redmine }) => {
        sent.push(redmine)
        stored = { ...stored, ...redmine }
        return { ok: true }
      },
    )
    await update((r) => ({ ...r, dailyTargetHours: 6.5 }))
    await update((r) => ({ ...r, endOfDay: { ...r.endOfDay, time: '17:30' } }))
    expect(sent[0]).toEqual({ dailyTargetHours: 6.5, endOfDay: { enabled: true, time: '18:00', sound: true } })
    expect(sent[1]).toEqual({ dailyTargetHours: 6.5, endOfDay: { enabled: true, time: '17:30', sound: true } })
    expect(Object.keys(sent[0]!)).not.toContain('url')
  })

  it('keeps going after a failed update', async () => {
    let stored = settings()
    let calls = 0
    const update = createRedmineUpdater(
      () => stored,
      async ({ redmine }) => {
        if (calls++ === 0) throw new Error('boom')
        stored = { ...stored, ...redmine }
        return { ok: true }
      },
    )
    await expect(update((r) => r)).rejects.toThrow('boom')
    await update((r) => ({ ...r, dailyTargetHours: 7 }))
    expect(stored.dailyTargetHours).toBe(7)
  })
})
