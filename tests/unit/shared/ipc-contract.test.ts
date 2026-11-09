import { describe, expect, it, vi } from 'vitest'
import { buildApi } from '../../../src/shared/ipc/build-api'
import { channels, eventChannels } from '../../../src/shared/ipc/channels'
import { contract, eventContract } from '../../../src/shared/ipc/contract'
import { err, ok } from '../../../src/shared/ipc/result'

const channelNames = Object.values(channels).flatMap((group) => Object.values(group))

describe('IPC contract', () => {
  it('defines a schema for every exposed channel and nothing else', () => {
    expect([...channelNames].sort()).toEqual(Object.keys(contract).sort())
  })

  it('defines a payload schema for every event channel', () => {
    expect(Object.values(eventChannels).sort()).toEqual(Object.keys(eventContract).sort())
  })

  it('validates request payloads for the notch channels', () => {
    expect(contract['notch:request'].input.safeParse({ intent: 'toggle' }).success).toBe(true)
    expect(contract['notch:request'].input.safeParse({ intent: 'explode' }).success).toBe(false)
    expect(contract['notch:pointer'].input.safeParse({ inside: 'yes' }).success).toBe(false)
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

  it('subscribes only to known event channels and returns an unsubscribe', () => {
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(() => unsubscribe)
    const api = buildApi(vi.fn(), subscribe)
    const listener = vi.fn()

    expect(api.events.on('notch:mode-changed', listener)).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith('notch:mode-changed', listener)
    expect(() => api.events.on('evil:event' as 'notch:mode-changed', listener)).toThrow(/Unknown event/)
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
