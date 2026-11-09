import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerIpc, type IpcEventLike, type IpcHandlers, type IpcMainLike } from '../../../src/main/ipc/register'
import { SettingsReadOnlyError } from '../../../src/main/services/settings-store'
import { contract } from '../../../src/shared/ipc/contract'
import { createDefaultSettings, settingsSchema } from '../../../src/shared/settings/schema'
import { createMemoryLogger } from '../helpers/memory-logger'

type Listener = (event: IpcEventLike, ...args: unknown[]) => unknown

function createFakeIpcMain() {
  const listeners = new Map<string, Listener>()
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => {
      listeners.set(channel, listener as Listener)
    },
    removeHandler: (channel) => {
      listeners.delete(channel)
    },
  }
  const invoke = async (channel: string, event: IpcEventLike, ...args: unknown[]) => {
    const listener = listeners.get(channel)
    if (!listener) throw new Error(`No handler for ${channel}`)
    return listener(event, ...args)
  }
  return { ipcMain, listeners, invoke }
}

const trustedEvent: IpcEventLike = { senderFrame: { url: 'app://trusted', parent: null } }
const settings = createDefaultSettings('en-US')

function createHandlers(overrides: Partial<IpcHandlers> = {}): IpcHandlers {
  return {
    'app:get-info': () => ({ name: 'Developer Notch', version: '0.1.0', platform: 'win32' }),
    'settings:get': () => settings,
    'settings:update': (patch) => settingsSchema.parse({ ...settings, ...patch }),
    ...overrides,
  }
}

describe('registerIpc', () => {
  let fake: ReturnType<typeof createFakeIpcMain>
  const logger = createMemoryLogger()

  beforeEach(() => {
    fake = createFakeIpcMain()
    logger.entries.length = 0
  })

  const register = (handlers = createHandlers()) =>
    registerIpc({
      ipcMain: fake.ipcMain,
      handlers,
      isTrustedUrl: (url) => url === 'app://trusted',
      logger,
    })

  it('registers exactly the channels in the contract', () => {
    register()
    expect([...fake.listeners.keys()].sort()).toEqual(Object.keys(contract).sort())
  })

  it('returns ok with validated output for a valid call', async () => {
    register()
    await expect(fake.invoke('settings:update', trustedEvent, { language: 'es' })).resolves.toEqual({
      ok: true,
      data: { ...settings, language: 'es' },
    })
  })

  it('rejects payloads that fail the input schema without calling the handler', async () => {
    const update = vi.fn()
    register(createHandlers({ 'settings:update': update }))

    const result = await fake.invoke('settings:update', trustedEvent, { language: 'fr' })

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(update).not.toHaveBeenCalled()
  })

  it('rejects extra arguments on no-input channels', async () => {
    register()
    const result = await fake.invoke('settings:get', trustedEvent, { sneaky: true })
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  })

  it('rejects untrusted senders, subframes and destroyed frames', async () => {
    const get = vi.fn(() => settings)
    register(createHandlers({ 'settings:get': get }))

    const untrusted = await fake.invoke('settings:get', { senderFrame: { url: 'https://evil.test', parent: null } })
    const subframe = await fake.invoke('settings:get', { senderFrame: { url: 'app://trusted', parent: {} } })
    const destroyed = await fake.invoke('settings:get', { senderFrame: null })

    for (const result of [untrusted, subframe, destroyed]) {
      expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    expect(get).not.toHaveBeenCalled()
    expect(logger.entries.filter((e) => e.level === 'warn')).toHaveLength(3)
  })

  it('maps handler exceptions to INTERNAL without leaking details', async () => {
    register(
      createHandlers({
        'settings:get': () => {
          throw new Error('disk exploded at C:\\secret\\path')
        },
      }),
    )

    const result = await fake.invoke('settings:get', trustedEvent)

    expect(result).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'Unexpected error' } })
    expect(logger.entries.some((e) => e.level === 'error')).toBe(true)
  })

  it('passes exposed error codes through to the renderer', async () => {
    register(
      createHandlers({
        'settings:update': () => {
          throw new SettingsReadOnlyError()
        },
      }),
    )
    const result = await fake.invoke('settings:update', trustedEvent, { language: 'es' })
    expect(result).toMatchObject({ ok: false, error: { code: 'READ_ONLY' } })
  })

  it('logs untrusted sender URLs without query strings', async () => {
    register()
    await fake.invoke('settings:get', { senderFrame: { url: 'https://evil.test/p?token=abc', parent: null } })
    expect(logger.entries[0]).toMatchObject({ meta: { url: 'https://evil.test/p' } })
  })

  it('rejects handler output that breaks the contract', async () => {
    register(createHandlers({ 'app:get-info': () => ({ name: 42 }) as never }))
    const result = await fake.invoke('app:get-info', trustedEvent)
    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
  })

  it('returns a disposer that removes every handler', () => {
    const dispose = register()
    dispose()
    expect(fake.listeners.size).toBe(0)
  })
})
