import { describe, expect, it, vi } from 'vitest'
import { buildApi } from '../../../src/shared/ipc/build-api'
import { channels } from '../../../src/shared/ipc/channels'
import { contract } from '../../../src/shared/ipc/contract'
import { err, ok } from '../../../src/shared/ipc/result'

const channelNames = Object.values(channels).flatMap((group) => Object.values(group))

describe('IPC contract', () => {
  it('defines a schema for every exposed channel and nothing else', () => {
    expect([...channelNames].sort()).toEqual(Object.keys(contract).sort())
  })

  it('uses unique, namespaced channel names', () => {
    expect(new Set(channelNames).size).toBe(channelNames.length)
    for (const name of channelNames) {
      expect(name).toMatch(/^[a-z]+:[a-z-]+$/)
    }
  })
})

describe('buildApi', () => {
  it('maps each method to an invoke on its channel', async () => {
    const invoke = vi.fn().mockResolvedValue(ok('done'))
    const api = buildApi(invoke)

    await api.settings.update({ language: 'en' })
    await api.settings.get()
    await api.app.getInfo()

    expect(invoke).toHaveBeenNthCalledWith(1, 'settings:update', { language: 'en' })
    expect(invoke).toHaveBeenNthCalledWith(2, 'settings:get', undefined)
    expect(invoke).toHaveBeenNthCalledWith(3, 'app:get-info', undefined)
  })

  it('turns transport failures into an INTERNAL result instead of rejecting', async () => {
    const api = buildApi(vi.fn().mockRejectedValue(new Error('No handler registered')))
    await expect(api.settings.get()).resolves.toEqual({
      ok: false,
      error: { code: 'INTERNAL', message: 'IPC call failed' },
    })
  })

  it('returns a frozen object so the renderer cannot add channels', () => {
    const api = buildApi(vi.fn())
    expect(Object.isFrozen(api)).toBe(true)
    expect(Object.isFrozen(api.settings)).toBe(true)
  })
})

describe('result helpers', () => {
  it('builds success and error results', () => {
    expect(ok(1)).toEqual({ ok: true, data: 1 })
    expect(err('FORBIDDEN', 'nope')).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'nope' } })
  })
})
