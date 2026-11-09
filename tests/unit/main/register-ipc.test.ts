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

const trustedEvent: IpcEventLike = { sender: { id: 1 }, senderFrame: { url: 'app://trusted', parent: null } }
const settings = createDefaultSettings('en-US')

function createHandlers(overrides: Partial<IpcHandlers> = {}): IpcHandlers {
  return {
    'app:get-info': () => ({ name: 'Developer Notch', version: '0.1.0', platform: 'win32' }),
    'app:get-runtime': () => ({ isPackaged: false, shortcutRegistered: true }),
    'app:open-control-center': () => null,
    'app:hide-notch': () => null,
    'notch:get-mode': () => 'compact',
    'notch:request': () => null,
    'notch:pointer': () => null,
    'notch:settled': () => null,
    'notch:open-integration': () => null,
    'notch:back': () => null,
    'terminal:open': () => ({ state: 'running', snapshot: '', shell: 'pwsh.exe' }),
    'terminal:input': () => null,
    'terminal:resize': () => null,
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

    const untrusted = await fake.invoke('settings:get', { sender: { id: 1 }, senderFrame: { url: 'https://evil.test', parent: null } })
    const subframe = await fake.invoke('settings:get', { sender: { id: 1 }, senderFrame: { url: 'app://trusted', parent: {} } })
    const destroyed = await fake.invoke('settings:get', { sender: { id: 1 }, senderFrame: null })

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
    await fake.invoke('settings:get', { sender: { id: 1 }, senderFrame: { url: 'https://evil.test/p?token=abc', parent: null } })
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

  it('applies per-channel sender guards before validating or calling the handler', async () => {
    const input = vi.fn(() => null)
    registerIpc({
      ipcMain: fake.ipcMain,
      handlers: createHandlers({ 'terminal:input': input }),
      isTrustedUrl: (url) => url === 'app://trusted',
      logger,
      channelGuards: { 'terminal:input': (event) => event.sender.id === 1 },
    })
    const other = { sender: { id: 2 }, senderFrame: { url: 'app://trusted', parent: null } }

    await expect(fake.invoke('terminal:input', other, { data: 'dir\r' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    })
    expect(input).not.toHaveBeenCalled()
    await expect(fake.invoke('terminal:input', trustedEvent, { data: 'dir\r' })).resolves.toEqual({ ok: true, data: null })
    expect(input).toHaveBeenCalledOnce()
  })
})

// Acceptance criterion 4: no IPC channel other than the terminal's own input can write to the session.
describe('terminal write isolation', () => {
  const sampleInput: { [C in keyof typeof contract]: unknown } = {
    'app:get-info': undefined,
    'app:get-runtime': undefined,
    'app:open-control-center': undefined,
    'app:hide-notch': undefined,
    'settings:get': undefined,
    'settings:update': { language: 'es' },
    'notch:get-mode': undefined,
    'notch:request': { intent: 'toggle' },
    'notch:pointer': { inside: true },
    'notch:settled': undefined,
    'notch:open-integration': { id: 'terminal' },
    'notch:back': undefined,
    'terminal:open': undefined,
    'terminal:input': { data: 'Get-ChildItem\r' },
    'terminal:resize': { cols: 80, rows: 24 },
  }

  it('has a sample input for every channel', () => {
    expect(Object.keys(sampleInput).sort()).toEqual(Object.keys(contract).sort())
  })

  it.each(Object.keys(sampleInput) as (keyof typeof contract)[])('%s writes to the session only if it is terminal:input', async (channel) => {
    const fake = createFakeIpcMain()
    const write = vi.fn()
    registerIpc({
      ipcMain: fake.ipcMain,
      handlers: createHandlers({
        'terminal:input': ({ data }) => {
          write(data)
          return null
        },
      }),
      isTrustedUrl: (url) => url === 'app://trusted',
      logger: createMemoryLogger(),
    })
    const result = await fake.invoke(channel, trustedEvent, ...(sampleInput[channel] === undefined ? [] : [sampleInput[channel]]))
    expect(result).toMatchObject({ ok: true })
    expect(write).toHaveBeenCalledTimes(channel === 'terminal:input' ? 1 : 0)
  })
})
