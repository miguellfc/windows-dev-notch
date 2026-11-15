import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installBridge, type TauriInternals } from '../../../src/tauri-bridge/bridge'
import type { NotchApi } from '../../../src/shared/ipc/api'

type Globals = { notch?: NotchApi; document?: { documentElement: { dataset: Record<string, string | undefined> } } }

// The bridge defines `notch` as non-configurable, so each test installs on a fresh fake global
// instead of the real `globalThis` (which is what the IIFE uses).
let fakeGlobal: Globals

function fakeInternals(overrides: Partial<TauriInternals> = {}): TauriInternals {
  return {
    invoke: vi.fn(() => Promise.resolve({ ok: true, data: null })),
    listen: vi.fn(() => Promise.resolve(() => undefined)),
    ...overrides,
  }
}

beforeEach(() => {
  fakeGlobal = { document: { documentElement: { dataset: {} } } }
})

const install = (internals: TauriInternals) => installBridge(internals, fakeGlobal)
const api = () => fakeGlobal.notch as NotchApi

describe('tauri bridge', () => {
  it('invokes notch_ipc with channel and input', async () => {
    const internals = fakeInternals()
    install(internals)

    await expect(api().settings.get()).resolves.toEqual({ ok: true, data: null })
    expect(internals.invoke).toHaveBeenCalledWith('notch_ipc', { channel: 'settings:get', input: undefined })

    await api().notch.pointer({ inside: true })
    expect(internals.invoke).toHaveBeenLastCalledWith('notch_ipc', { channel: 'notch:pointer', input: { inside: true } })
  })

  it('marks the document as running under tauri', () => {
    install(fakeInternals())
    expect(fakeGlobal.document?.documentElement.dataset['runtime']).toBe('tauri')
  })

  it('resolves INTERNAL when invoke rejects', async () => {
    install(fakeInternals({ invoke: vi.fn(() => Promise.reject(new Error('window closed'))) }))
    await expect(api().settings.get()).resolves.toEqual({
      ok: false,
      error: { code: 'INTERNAL', message: 'IPC call failed' },
    })
  })

  it('window.notch is frozen and not writable', () => {
    install(fakeInternals())
    const notch = api()
    const descriptor = Object.getOwnPropertyDescriptor(fakeGlobal, 'notch')
    expect(descriptor?.writable).toBe(false)
    expect(descriptor?.configurable).toBe(false)
    expect(Object.isFrozen(notch)).toBe(true)
    expect(Object.isFrozen(notch.settings)).toBe(true)
    expect(() => {
      ;(fakeGlobal as Record<string, unknown>)['notch'] = {}
    }).toThrow(TypeError)
    expect(fakeGlobal.notch).toBe(notch)
  })

  it('events.on forwards to listen and returns an unsubscribe', async () => {
    const unlisten = vi.fn()
    let forward: ((payload: unknown) => void) | undefined
    const internals = fakeInternals({
      listen: vi.fn((_event: string, cb: (payload: unknown) => void) => {
        forward = cb
        return Promise.resolve(unlisten)
      }),
    })
    install(internals)

    const listener = vi.fn()
    const unsubscribe = api().events.on('settings:changed', listener)
    expect(internals.listen).toHaveBeenCalledWith('settings:changed', expect.any(Function))

    forward?.({ theme: 'dark' })
    expect(listener).toHaveBeenCalledWith({ theme: 'dark' })

    unsubscribe()
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1))
    // Events that arrive after unsubscribing are dropped even before unlisten settles.
    forward?.({ theme: 'light' })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('unlistens when unsubscribe happens before listen resolves', async () => {
    const unlisten = vi.fn()
    let resolveListen: ((value: () => void) => void) | undefined
    install(
      fakeInternals({
        listen: vi.fn(() => new Promise<() => void>((resolve) => (resolveListen = resolve))),
      }),
    )

    const unsubscribe = api().events.on('notes:changed', vi.fn())
    unsubscribe()
    resolveListen?.(unlisten)
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1))
  })

  it('handles a refused listen at once and still unsubscribes cleanly', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      install(fakeInternals({ listen: vi.fn(() => Promise.reject(new Error('event.listen not allowed: secret'))) }))

      const unsubscribe = api().events.on('settings:changed', vi.fn())
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('notch bridge: could not listen to settings:changed'))
      expect(warn.mock.calls.flat().join(' ')).not.toContain('secret')
      expect(() => unsubscribe()).not.toThrow()
      // Give a rejection a chance to surface as unhandled.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
      warn.mockRestore()
    }
  })

  it('rejects unknown events', () => {
    install(fakeInternals())
    expect(() => api().events.on('nope' as never, vi.fn())).toThrow('Unknown event: nope')
  })
})
