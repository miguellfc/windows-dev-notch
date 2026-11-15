import { describe, expect, it } from 'vitest'
import { createGmailUpdater, type GmailSettings } from '../../../src/renderer/control-center/gmail-settings-patch'

describe('createGmailUpdater', () => {
  it('builds each patch from the block left by the previous update', async () => {
    let stored: GmailSettings = { clientId: 'a', clientSecret: 'b', alerts: { enabled: true, hideContent: false, sound: true } }
    const sent: GmailSettings[] = []
    const update = createGmailUpdater(
      () => stored,
      async ({ gmail }) => {
        sent.push(gmail)
        await new Promise((resolve) => setTimeout(resolve, 10))
        stored = gmail // the store only changes once the IPC resolves
        return { ok: true }
      },
    )
    const first = update((g) => ({ ...g, alerts: { ...g.alerts, enabled: false } }))
    const second = update((g) => ({ ...g, alerts: { ...g.alerts, sound: false } }))
    await Promise.all([first, second])
    expect(sent[1]?.alerts).toEqual({ enabled: false, hideContent: false, sound: false })
    expect(stored.alerts).toEqual({ enabled: false, hideContent: false, sound: false })
  })

  it('keeps going after a failed update', async () => {
    let stored: GmailSettings = { clientId: '', clientSecret: '', alerts: { enabled: true, hideContent: false, sound: true } }
    let calls = 0
    const update = createGmailUpdater(
      () => stored,
      async ({ gmail }) => {
        if (calls++ === 0) throw new Error('boom')
        stored = gmail
        return { ok: true }
      },
    )
    await expect(update((g) => g)).rejects.toThrow('boom')
    await update((g) => ({ ...g, clientId: 'x' }))
    expect(stored.clientId).toBe('x')
  })
})
