import { describe, expect, it, vi } from 'vitest'
import { registerIpc, type IpcEventLike, type IpcHandlers, type IpcMainLike } from '../../../src/main/ipc/register'
import { createSystemIpcHandlers, systemChannelGuards } from '../../../src/main/system/system-ipc'
import { createMemoryLogger } from '../helpers/memory-logger'

type Listener = (event: IpcEventLike, ...args: unknown[]) => unknown

const NOTCH = 1
const CONTROL_CENTER = 2
const OTHER = 3
const from = (id: number): IpcEventLike => ({ sender: { id }, senderFrame: { url: 'app://trusted', parent: null } })
const START = '2026-11-10T09:00:00.000Z'

function setup() {
  const monitor = { setOrder: vi.fn(), kill: vi.fn(() => 'killed' as const) }
  const listeners = new Map<string, Listener>()
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => void listeners.set(channel, listener as Listener),
    removeHandler: (channel) => void listeners.delete(channel),
  }
  registerIpc({
    ipcMain,
    // Only the system channels are exercised here.
    handlers: createSystemIpcHandlers(monitor) as unknown as IpcHandlers,
    isTrustedUrl: (url) => url === 'app://trusted',
    logger: createMemoryLogger(),
    channelGuards: systemChannelGuards({ fromNotch: (event) => event.sender.id === NOTCH }),
  })
  const invoke = (channel: string, id: number, ...args: unknown[]) => {
    const listener = listeners.get(channel)
    if (!listener) throw new Error(`No handler for ${channel}`)
    return listener(from(id), ...args)
  }
  return { monitor, invoke }
}

describe('system IPC', () => {
  it('sets the process order (the view itself follows the notch mode)', async () => {
    const { monitor, invoke } = setup()
    await expect(invoke('system:view', NOTCH, { by: 'ram' })).resolves.toEqual({ ok: true, data: null })
    expect(monitor.setOrder).toHaveBeenLastCalledWith('ram')
    await invoke('system:view', NOTCH, { by: 'cpu' })
    expect(monitor.setOrder).toHaveBeenLastCalledWith('cpu')
  })

  it('closes a process and returns the result', async () => {
    const { monitor, invoke } = setup()
    await expect(invoke('system:kill-process', NOTCH, { pid: 42, startTime: START })).resolves.toEqual({ ok: true, data: 'killed' })
    expect(monitor.kill).toHaveBeenCalledWith({ pid: 42, startTime: START })
  })

  it.each(['system:view', 'system:kill-process'])('%s is forbidden outside the notch', async (channel) => {
    const { monitor, invoke } = setup()
    const input = channel === 'system:view' ? { by: 'cpu' } : { pid: 42, startTime: START }
    for (const id of [CONTROL_CENTER, OTHER]) {
      await expect(invoke(channel, id, input)).resolves.toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    expect(monitor.setOrder).not.toHaveBeenCalled()
    expect(monitor.kill).not.toHaveBeenCalled()
  })

  it.each([
    ['system:view', { open: true }],
    ['system:view', { by: 'cpu', open: false }],
    ['system:view', { by: 'disk' }],
    ['system:view', { by: 'cpu', extra: 1 }],
    ['system:view', undefined],
    ['system:kill-process', { pid: 0, startTime: START }],
    ['system:kill-process', { pid: 1.5, startTime: START }],
    ['system:kill-process', { pid: 42 }],
    ['system:kill-process', { pid: 42, startTime: 'x'.repeat(41) }],
    ['system:kill-process', { pid: 42, startTime: START, name: 'chrome.exe' }],
  ])('%s rejects %j as INVALID_INPUT', async (channel, input) => {
    const { monitor, invoke } = setup()
    const args = input === undefined ? [] : [input]
    await expect(invoke(channel, NOTCH, ...args)).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(monitor.setOrder).not.toHaveBeenCalled()
    expect(monitor.kill).not.toHaveBeenCalled()
  })
})
