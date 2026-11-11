import { beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeChannelGuards } from '../../../src/main/claude/claude-ipc'
import { registerIpc, type IpcEventLike, type IpcHandlers, type IpcMainLike } from '../../../src/main/ipc/register'
import { SettingsReadOnlyError } from '../../../src/main/services/settings-store'
import { createUsageIpcHandlers, usageChannelGuards } from '../../../src/main/services/usage-ipc'
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
const REMINDER_ID = '3f2c8a1e-5b7d-4c9e-8f10-2a3b4c5d6e7f'
const sampleReminder = {
  id: REMINDER_ID,
  text: 'Revisar PR',
  dueAt: '2026-11-10T10:00:00.000Z',
  repeat: 'none',
  state: 'pending',
  createdAt: '2026-11-10T09:00:00.000Z',
} as const

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
    'claude:get-state': () => ({ connection: 'not-installed', hooks: 'missing', sessions: [], pending: [] }),
    'claude:decide': () => null,
    'claude:focus-app': () => null,
    'claude:dismiss-session': () => null,
    'claude:hooks-preview': () => ({ ok: true, diff: [] }),
    'claude:hooks-install': () => ({ ok: true, changed: false, diff: [] }),
    'claude:hooks-uninstall': () => ({ ok: true, changed: false, diff: [] }),
    'claude:test-connection': () => ({ ok: true }),
    'claude:rotate-token': () => ({ hooks: 'reinstalled' }),
    'claude:rotate-port': () => ({ hooks: 'not-installed' }),
    'reminders:list': () => ({ reminders: [sampleReminder], notice: null }),
    'reminders:create': () => sampleReminder,
    'reminders:update': () => sampleReminder,
    'reminders:snooze': () => sampleReminder,
    'reminders:complete': () => sampleReminder,
    'reminders:delete': () => null,
    'usage:summary': () => ({
      days: 0,
      runningHoursAvg: 0,
      launches: 0,
      remindersFired: 0,
      remindersMissed: 0,
      remindersCompleted: 0,
      claudeAlerts: 0,
      claudeLatencyMedianMs: null,
      claudeLatencyP95Ms: null,
      from: '2026-10-28',
      to: '2026-11-10',
    }),
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
    'claude:get-state': undefined,
    'claude:decide': { requestId: '3f2c8a1e-5b7d-4c9e-8f10-2a3b4c5d6e7f', decision: 'allow' },
    'claude:focus-app': undefined,
    'claude:dismiss-session': { sessionId: 'session-1' },
    'claude:hooks-preview': undefined,
    'claude:hooks-install': undefined,
    'claude:hooks-uninstall': undefined,
    'claude:test-connection': undefined,
    'claude:rotate-token': undefined,
    'claude:rotate-port': undefined,
    'reminders:list': undefined,
    'reminders:create': { input: 'en 30 min revisar PR' },
    'reminders:update': { id: REMINDER_ID, text: 'Otro' },
    'reminders:snooze': { id: REMINDER_ID },
    'reminders:complete': { id: REMINDER_ID },
    'reminders:delete': { id: REMINDER_ID },
    'usage:summary': { days: 14 },
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

// Claude channels: decisions only from the notch, hooks and token only from the Control Center.
describe('claude channel guards', () => {
  const NOTCH = 1
  const CONTROL_CENTER = 2
  const OTHER = 3
  const allowed: Record<Extract<keyof typeof contract, `claude:${string}`>, 'notch' | 'control-center' | 'both'> = {
    'claude:get-state': 'both',
    'claude:decide': 'notch',
    'claude:focus-app': 'notch',
    'claude:dismiss-session': 'notch',
    'claude:hooks-preview': 'control-center',
    'claude:hooks-install': 'control-center',
    'claude:hooks-uninstall': 'control-center',
    'claude:test-connection': 'control-center',
    'claude:rotate-token': 'control-center',
    'claude:rotate-port': 'control-center',
  }
  const sample: Record<string, unknown> = {
    'claude:decide': { requestId: '3f2c8a1e-5b7d-4c9e-8f10-2a3b4c5d6e7f', decision: 'allow' },
    'claude:dismiss-session': { sessionId: 'session-1' },
  }

  it('covers every claude channel', () => {
    expect(Object.keys(allowed).sort()).toEqual(Object.keys(contract).filter((c) => c.startsWith('claude:')).sort())
  })

  it.each(Object.entries(allowed))('%s is reachable only from %s', async (channel, who) => {
    const fake = createFakeIpcMain()
    const handler = vi.fn(createHandlers()[channel as keyof IpcHandlers] as () => unknown)
    registerIpc({
      ipcMain: fake.ipcMain,
      handlers: createHandlers({ [channel]: handler }),
      isTrustedUrl: (url) => url === 'app://trusted',
      logger: createMemoryLogger(),
      channelGuards: claudeChannelGuards({
        fromNotch: (event) => event.sender.id === NOTCH,
        // The Control Center may not exist yet: a guard that never matches.
        fromControlCenter: (event) => event.sender.id === CONTROL_CENTER,
      }),
    })
    const from = (id: number) => ({ sender: { id }, senderFrame: { url: 'app://trusted', parent: null } })
    const args = sample[channel] === undefined ? [] : [sample[channel]]
    const expectFor = (id: number) =>
      (who === 'both' && id !== OTHER) || (who === 'notch' && id === NOTCH) || (who === 'control-center' && id === CONTROL_CENTER)

    for (const id of [NOTCH, CONTROL_CENTER, OTHER]) {
      const result = await fake.invoke(channel, from(id), ...args)
      expect(result).toMatchObject(expectFor(id) ? { ok: true } : { ok: false, error: { code: 'FORBIDDEN' } })
    }
    expect(handler).toHaveBeenCalledTimes(who === 'both' ? 2 : 1)
  })
})

// Usage: the summary is for the Control Center's About page only.
describe('usage channel', () => {
  const NOTCH = 1
  const CONTROL_CENTER = 2
  const OTHER = 3
  const from = (id: number) => ({ sender: { id }, senderFrame: { url: 'app://trusted', parent: null } })

  const setup = () => {
    const fake = createFakeIpcMain()
    let release: () => void = () => undefined
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const summary = vi.fn((days: number) => ({ ...createHandlers()['usage:summary'](undefined as never), days: days === 30 ? 1 : 0 }))
    const handlers = createUsageIpcHandlers({ summary } as never, () => ready)
    registerIpc({
      ipcMain: fake.ipcMain,
      handlers: createHandlers(handlers),
      isTrustedUrl: (url) => url === 'app://trusted',
      logger: createMemoryLogger(),
      channelGuards: usageChannelGuards({ fromControlCenter: (event) => event.sender.id === CONTROL_CENTER }),
    })
    return { fake, summary, release }
  }

  it('is reachable only from the Control Center', async () => {
    const { fake, summary, release } = setup()
    release()
    for (const id of [NOTCH, OTHER]) {
      await expect(fake.invoke('usage:summary', from(id), { days: 14 })).resolves.toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    expect(summary).not.toHaveBeenCalled()
    await expect(fake.invoke('usage:summary', from(CONTROL_CENTER), { days: 14 })).resolves.toMatchObject({ ok: true })
  })

  it('defaults to 14 days, passes the range through and waits for the log to load', async () => {
    const { fake, summary, release } = setup()
    const pending = fake.invoke('usage:summary', from(CONTROL_CENTER), {})
    await Promise.resolve()
    expect(summary).not.toHaveBeenCalled()
    release()
    await expect(pending).resolves.toMatchObject({ ok: true })
    expect(summary).toHaveBeenLastCalledWith(14)
    await expect(fake.invoke('usage:summary', from(CONTROL_CENTER), { days: 30 })).resolves.toMatchObject({ ok: true, data: { days: 1 } })
    expect(summary).toHaveBeenLastCalledWith(30)
  })

  it('rejects ranges other than 7, 14 and 30 before calling the log', async () => {
    const { fake, summary, release } = setup()
    release()
    await expect(fake.invoke('usage:summary', from(CONTROL_CENTER), { days: 90 })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    })
    expect(summary).not.toHaveBeenCalled()
  })
})
