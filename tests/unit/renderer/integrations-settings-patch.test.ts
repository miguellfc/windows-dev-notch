import { describe, expect, it } from 'vitest'
import { createIntegrationsUpdater } from '../../../src/renderer/control-center/integrations-settings-patch'
import { cloneDefaultIntegrations, type IntegrationsSettings } from '../../../src/shared/settings/schema'

describe('createIntegrationsUpdater', () => {
  it('sends one patch per key, so two quick changes never overwrite each other', async () => {
    let stored: IntegrationsSettings = cloneDefaultIntegrations()
    const sent: unknown[] = []
    const update = createIntegrationsUpdater(
      () => stored,
      async (patch) => {
        sent.push(patch)
        await new Promise((resolve) => setTimeout(resolve, 10))
        // The store merges per key and field once the IPC resolves.
        const next = structuredClone(stored)
        for (const [key, fields] of Object.entries(patch.integrations)) Object.assign(next[key as keyof IntegrationsSettings], fields)
        stored = next
        return { ok: true }
      },
    )
    const first = update('gmail', { color: 'pink' })
    const second = update('github', { enabled: false })
    await Promise.all([first, second])
    expect(sent).toEqual([{ integrations: { gmail: { color: 'pink' } } }, { integrations: { github: { enabled: false } } }])
    expect(stored.gmail.color).toBe('pink')
    expect(stored.github.enabled).toBe(false)
    expect(stored.gmail.enabled).toBe(true)
  })

  it('keeps going after a failed update', async () => {
    let calls = 0
    const sent: unknown[] = []
    const update = createIntegrationsUpdater(
      () => cloneDefaultIntegrations(),
      async (patch) => {
        if (calls++ === 0) throw new Error('boom')
        sent.push(patch)
        return { ok: true }
      },
    )
    await expect(update('notes', { enabled: false })).rejects.toThrow('boom')
    await update('notes', { color: 'sand' })
    expect(sent).toEqual([{ integrations: { notes: { color: 'sand' } } }])
  })
})
