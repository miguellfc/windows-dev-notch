import { describe, expect, it, vi } from 'vitest'
import { ExposedIpcError } from '../../../src/main/ipc/errors'
import { registerIpc, type IpcEventLike, type IpcHandlers, type IpcMainLike } from '../../../src/main/ipc/register'
import { createRemindersIpcHandlers, remindersChannelGuards } from '../../../src/main/reminders/reminders-ipc'
import type { RemindersService } from '../../../src/main/reminders/reminders-service'
import { contract } from '../../../src/shared/ipc/contract'
import type { Reminder } from '../../../src/shared/reminders/schema'
import { createMemoryLogger } from '../helpers/memory-logger'

const ID = '3f2c8a1e-5b7d-4c9e-8f10-2a3b4c5d6e7f'
const reminder: Reminder = {
  id: ID,
  text: 'Revisar PR',
  dueAt: '2026-11-10T10:00:00.000Z',
  repeat: 'none',
  state: 'pending',
  createdAt: '2026-11-10T09:00:00.000Z',
}

type Listener = (event: IpcEventLike, ...args: unknown[]) => unknown

function fakeService() {
  return {
    list: vi.fn(() => [reminder]),
    create: vi.fn(async () => reminder),
    update: vi.fn(async () => ({ ...reminder, text: 'Otro' })),
    snooze: vi.fn(async () => reminder),
    complete: vi.fn(async () => ({ ...reminder, state: 'done' as const, completedAt: '2026-11-10T10:01:00.000Z' })),
    remove: vi.fn(async () => undefined),
  } satisfies Partial<RemindersService>
}

const NOTCH = 1
const CONTROL_CENTER = 2
const OTHER = 3
const from = (id: number): IpcEventLike => ({ sender: { id }, senderFrame: { url: 'app://trusted', parent: null } })

function setup(notice: 'quarantined' | 'read-only' | null = null) {
  const service = fakeService()
  const listeners = new Map<string, Listener>()
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => void listeners.set(channel, listener as Listener),
    removeHandler: (channel) => void listeners.delete(channel),
  }
  const handlers = createRemindersIpcHandlers(service, () => ({ reminders: service.list(), notice }))
  registerIpc({
    ipcMain,
    // Only the reminders channels are exercised here.
    handlers: handlers as unknown as IpcHandlers,
    isTrustedUrl: (url) => url === 'app://trusted',
    channelGuards: remindersChannelGuards({
      fromNotch: (event) => event.sender.id === NOTCH,
      fromControlCenter: (event) => event.sender.id === CONTROL_CENTER,
    }),
    logger: createMemoryLogger(),
  })
  const invoke = (channel: string, sender: number, ...args: unknown[]) => listeners.get(channel)!(from(sender), ...args)
  return { service, invoke }
}

describe('reminders IPC handlers', () => {
  it('lists reminders with the store notice', async () => {
    const { invoke } = setup('quarantined')
    await expect(invoke('reminders:list', NOTCH)).resolves.toEqual({
      ok: true,
      data: { reminders: [reminder], notice: 'quarantined' },
    })
  })

  it('passes each call to the service', async () => {
    const { invoke, service } = setup()
    await expect(invoke('reminders:create', NOTCH, { input: 'en 30 min revisar PR' })).resolves.toMatchObject({ ok: true })
    expect(service.create).toHaveBeenCalledWith({ input: 'en 30 min revisar PR' })
    await invoke('reminders:create', NOTCH, { text: 'Revisar PR', preset: '15m' })
    expect(service.create).toHaveBeenLastCalledWith({ text: 'Revisar PR', preset: '15m' })

    await expect(invoke('reminders:update', CONTROL_CENTER, { id: ID, text: 'Otro' })).resolves.toMatchObject({
      ok: true,
      data: { text: 'Otro' },
    })
    expect(service.update).toHaveBeenCalledWith({ id: ID, text: 'Otro' })

    await invoke('reminders:snooze', NOTCH, { id: ID })
    expect(service.snooze).toHaveBeenCalledWith(ID)
    await expect(invoke('reminders:complete', NOTCH, { id: ID })).resolves.toMatchObject({ ok: true, data: { state: 'done' } })
    expect(service.complete).toHaveBeenCalledWith(ID)
    await expect(invoke('reminders:delete', CONTROL_CENTER, { id: ID })).resolves.toEqual({ ok: true, data: null })
    expect(service.remove).toHaveBeenCalledWith(ID)
  })

  it('rejects invalid inputs with INVALID_INPUT before reaching the service', async () => {
    const { invoke, service } = setup()
    const bad: [string, number, unknown][] = [
      ['reminders:create', NOTCH, { input: 'x'.repeat(401) }],
      ['reminders:create', NOTCH, { text: 'a\u0000b', preset: '15m' }],
      ['reminders:create', NOTCH, { text: 'ok', preset: '2h' }],
      ['reminders:update', CONTROL_CENTER, { id: ID }],
      ['reminders:update', CONTROL_CENTER, { id: 'nope', text: 'x' }],
      ['reminders:snooze', NOTCH, { id: 'not-a-uuid' }],
      ['reminders:complete', NOTCH, { id: ID, extra: true }],
      ['reminders:delete', NOTCH, undefined],
    ]
    for (const [channel, sender, input] of bad) {
      const result = await invoke(channel, sender, input)
      expect(result, channel).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    }
    expect(service.create).not.toHaveBeenCalled()
    expect(service.update).not.toHaveBeenCalled()
    expect(service.snooze).not.toHaveBeenCalled()
    expect(service.complete).not.toHaveBeenCalled()
    expect(service.remove).not.toHaveBeenCalled()
  })

  it('forwards service refusals (NOT_FOUND, READ_ONLY) as their codes', async () => {
    const { invoke, service } = setup()
    service.snooze.mockRejectedValueOnce(new ExposedIpcError('NOT_FOUND', 'Reminder not found'))
    await expect(invoke('reminders:snooze', NOTCH, { id: ID })).resolves.toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    service.remove.mockRejectedValueOnce(new ExposedIpcError('READ_ONLY', 'read only'))
    await expect(invoke('reminders:delete', NOTCH, { id: ID })).resolves.toMatchObject({ ok: false, error: { code: 'READ_ONLY' } })
  })
})

describe('reminders channel guards', () => {
  const allowed: Record<Extract<keyof typeof contract, `reminders:${string}`>, 'control-center' | 'both'> = {
    'reminders:list': 'both',
    'reminders:create': 'both',
    'reminders:update': 'control-center',
    'reminders:snooze': 'both',
    'reminders:complete': 'both',
    'reminders:delete': 'both',
  }
  const sample: Record<string, unknown> = {
    'reminders:create': { input: 'en 30 min revisar PR' },
    'reminders:update': { id: ID, text: 'Otro' },
    'reminders:snooze': { id: ID },
    'reminders:complete': { id: ID },
    'reminders:delete': { id: ID },
  }

  it('covers every reminders channel', () => {
    expect(Object.keys(allowed).sort()).toEqual(Object.keys(contract).filter((c) => c.startsWith('reminders:')).sort())
  })

  it.each(Object.entries(allowed))('%s is reachable only from %s', async (channel, who) => {
    const { invoke } = setup()
    const args = sample[channel] === undefined ? [] : [sample[channel]]
    for (const id of [NOTCH, CONTROL_CENTER, OTHER]) {
      const expected = id === CONTROL_CENTER || (who === 'both' && id === NOTCH)
      const result = await invoke(channel, id, ...args)
      expect(result, `${channel} from ${id}`).toMatchObject(expected ? { ok: true } : { ok: false, error: { code: 'FORBIDDEN' } })
    }
  })

  it('refuses reminders:update from the notch', async () => {
    const { invoke, service } = setup()
    await expect(invoke('reminders:update', NOTCH, { id: ID, text: 'Otro' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    })
    expect(service.update).not.toHaveBeenCalled()
  })
})
