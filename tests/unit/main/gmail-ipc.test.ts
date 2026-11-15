import { describe, expect, it, vi } from 'vitest'
import { createGmailIpcHandlers, gmailChannelGuards } from '../../../src/main/gmail/gmail-ipc'
import { registerIpc, type IpcEventLike, type IpcHandlers, type IpcMainLike } from '../../../src/main/ipc/register'
import { ExposedIpcError } from '../../../src/main/ipc/errors'
import type { GmailMessage, GmailMessageDetail, GmailState } from '../../../src/shared/gmail/schema'
import { contract } from '../../../src/shared/ipc/contract'
import { createMemoryLogger } from '../helpers/memory-logger'

type Listener = (event: IpcEventLike, ...args: unknown[]) => unknown

const NOTCH = 1
const CONTROL_CENTER = 2
const OTHER = 3
const from = (id: number): IpcEventLike => ({ sender: { id }, senderFrame: { url: 'app://trusted', parent: null } })

const okState: GmailState = { status: 'ok', account: 'me@x.com', unread: 3, updatedAt: '2026-11-11T10:00:00.000Z', persistent: true, reason: null }
const detail = (id: string): GmailMessageDetail => ({
  id,
  threadId: `t${id}`,
  from: 'A',
  fromAddress: 'a@example.com',
  subject: 'S',
  date: '2026-11-11T09:00:00.000Z',
  unread: true,
  body: 'B',
  truncated: false,
  links: [],
  attachments: 0,
})
const msg = (id: string): GmailMessage => ({ id, threadId: `t${id}`, from: 'A', subject: 'S', snippet: '', date: '2026-11-11T09:00:00.000Z', unread: false })

function setup(options: { ready?: Promise<void>; recent?: GmailMessage[]; state?: unknown; picked?: unknown; detail?: unknown } = {}) {
  const gmail = {
    ready: options.ready ?? Promise.resolve(),
    state: vi.fn(() => (options.state ?? okState) as GmailState),
    recent: vi.fn(async () => options.recent ?? [msg('1')]),
    setViewOpen: vi.fn(),
    refresh: vi.fn(),
    open: vi.fn(),
    signIn: vi.fn(async () => 'ok' as const),
    cancelSignIn: vi.fn(),
    signOut: vi.fn(async () => undefined),
    message: vi.fn(async (id: string) => (options.detail ?? detail(id)) as GmailMessageDetail),
    markRead: vi.fn<(id: string) => Promise<void>>(async () => undefined),
    remove: vi.fn<(id: string) => Promise<void>>(async () => undefined),
    openLink: vi.fn<(id: string, index: number) => void>(() => undefined),
    closeMessage: vi.fn(),
  }
  const pickClientFile = vi.fn(async () => (options.picked === undefined ? { clientId: 'id', clientSecret: 'sec' } : options.picked))
  const listeners = new Map<string, Listener>()
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => void listeners.set(channel, listener as Listener),
    removeHandler: (channel) => void listeners.delete(channel),
  }
  registerIpc({
    ipcMain,
    // Only the gmail channels are exercised here.
    handlers: createGmailIpcHandlers(gmail, pickClientFile as never) as unknown as IpcHandlers,
    isTrustedUrl: (url) => url === 'app://trusted',
    logger: createMemoryLogger(),
    channelGuards: gmailChannelGuards({
      fromNotch: (event) => event.sender.id === NOTCH,
      fromControlCenter: (event) => event.sender.id === CONTROL_CENTER,
    }),
  })
  const invoke = (channel: string, id: number, ...args: unknown[]) => {
    const listener = listeners.get(channel)
    if (!listener) throw new Error(`No handler for ${channel}`)
    return listener(from(id), ...args)
  }
  return { gmail, invoke, pickClientFile }
}

const allowed: Record<Extract<keyof typeof contract, `gmail:${string}`>, 'notch' | 'control-center' | 'both'> = {
  'gmail:get-state': 'both',
  'gmail:recent': 'notch',
  'gmail:view': 'notch',
  'gmail:refresh': 'notch',
  'gmail:open': 'notch',
  'gmail:sign-in': 'control-center',
  'gmail:cancel-sign-in': 'control-center',
  'gmail:sign-out': 'control-center',
  'gmail:pick-client-file': 'control-center',
  'gmail:message': 'notch',
  'gmail:mark-read': 'notch',
  'gmail:delete': 'notch',
  'gmail:open-link': 'notch',
  'gmail:close-message': 'notch',
}
const sample: Record<string, unknown> = {
  'gmail:view': { open: true },
  'gmail:open': { id: '1' },
  'gmail:message': { id: '1' },
  'gmail:mark-read': { id: '1' },
  'gmail:delete': { id: '1' },
  'gmail:open-link': { id: '1', index: 0 },
}

describe('gmail IPC guards', () => {
  it('covers every gmail channel', () => {
    expect(Object.keys(allowed).sort()).toEqual(Object.keys(contract).filter((c) => c.startsWith('gmail:')).sort())
  })

  it.each(Object.entries(allowed))('%s is reachable only from %s', async (channel, who) => {
    const { invoke } = setup()
    const args = sample[channel] === undefined ? [] : [sample[channel]]
    for (const id of [NOTCH, CONTROL_CENTER, OTHER]) {
      const allowedHere = (who === 'both' && id !== OTHER) || (who === 'notch' && id === NOTCH) || (who === 'control-center' && id === CONTROL_CENTER)
      await expect(invoke(channel, id, ...args)).resolves.toMatchObject(allowedHere ? { ok: true } : { ok: false, error: { code: 'FORBIDDEN' } })
    }
  })
})

describe('gmail IPC handlers', () => {
  it('get-state waits for the integration to load', async () => {
    let release: () => void = () => undefined
    const { gmail, invoke } = setup({ ready: new Promise<void>((resolve) => (release = resolve)) })
    const pending = invoke('gmail:get-state', CONTROL_CENTER)
    await Promise.resolve()
    expect(gmail.state).not.toHaveBeenCalled()
    release()
    await expect(pending).resolves.toEqual({ ok: true, data: okState })
  })

  it('passes view, refresh, open and sign-in calls through', async () => {
    const { gmail, invoke } = setup()
    await expect(invoke('gmail:view', NOTCH, { open: true })).resolves.toEqual({ ok: true, data: null })
    expect(gmail.setViewOpen).toHaveBeenCalledWith(true)
    await invoke('gmail:refresh', NOTCH)
    expect(gmail.refresh).toHaveBeenCalledOnce()
    await invoke('gmail:open', NOTCH, { id: 'abc' })
    expect(gmail.open).toHaveBeenLastCalledWith('abc')
    await invoke('gmail:open', NOTCH, {})
    expect(gmail.open).toHaveBeenLastCalledWith(undefined)
    await expect(invoke('gmail:sign-in', CONTROL_CENTER)).resolves.toEqual({ ok: true, data: 'ok' })
    await invoke('gmail:cancel-sign-in', CONTROL_CENTER)
    expect(gmail.cancelSignIn).toHaveBeenCalledOnce()
    await expect(invoke('gmail:sign-out', CONTROL_CENTER)).resolves.toEqual({ ok: true, data: null })
    expect(gmail.signOut).toHaveBeenCalledOnce()
    await expect(invoke('gmail:recent', NOTCH)).resolves.toEqual({ ok: true, data: [msg('1')] })
  })

  it('pick-client-file returns the credentials, null on cancel, and rejects extra output fields', async () => {
    await expect(setup().invoke('gmail:pick-client-file', CONTROL_CENTER)).resolves.toEqual({ ok: true, data: { clientId: 'id', clientSecret: 'sec' } })
    await expect(setup({ picked: null }).invoke('gmail:pick-client-file', CONTROL_CENTER)).resolves.toEqual({ ok: true, data: null })
    await expect(setup({ picked: { clientId: 'id', clientSecret: 's', extra: 1 } }).invoke('gmail:pick-client-file', CONTROL_CENTER)).resolves.toMatchObject({ ok: false })
    await expect(setup().invoke('gmail:pick-client-file', CONTROL_CENTER, { path: '/x' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  })

  it('validates inputs: the renderer never sends a URL', async () => {
    const { gmail, invoke } = setup()
    await expect(invoke('gmail:open', NOTCH, { url: 'https://evil.test' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    await expect(invoke('gmail:view', NOTCH, { open: 'yes' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    await expect(invoke('gmail:refresh', NOTCH, { force: true })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(gmail.open).not.toHaveBeenCalled()
    expect(gmail.setViewOpen).not.toHaveBeenCalled()
  })

  it('close-message makes main forget the open message, taking no input', async () => {
    const { gmail, invoke } = setup()
    await expect(invoke('gmail:close-message', NOTCH)).resolves.toEqual({ ok: true, data: null })
    expect(gmail.closeMessage).toHaveBeenCalledOnce()
    await expect(invoke('gmail:close-message', NOTCH, { id: 'm1' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(gmail.closeMessage).toHaveBeenCalledOnce()
  })

  it('passes message, mark-read, delete and open-link through after the token loads', async () => {
    const { gmail, invoke } = setup()
    await expect(invoke('gmail:message', NOTCH, { id: 'm1' })).resolves.toEqual({ ok: true, data: detail('m1') })
    expect(gmail.message).toHaveBeenCalledWith('m1')
    await expect(invoke('gmail:mark-read', NOTCH, { id: 'm1' })).resolves.toEqual({ ok: true, data: null })
    expect(gmail.markRead).toHaveBeenCalledWith('m1')
    await expect(invoke('gmail:delete', NOTCH, { id: 'm1' })).resolves.toEqual({ ok: true, data: null })
    expect(gmail.remove).toHaveBeenCalledWith('m1')
    await expect(invoke('gmail:open-link', NOTCH, { id: 'm1', index: 3 })).resolves.toEqual({ ok: true, data: null })
    expect(gmail.openLink).toHaveBeenCalledWith('m1', 3)
  })

  it('exposes INVALID_INPUT and NOT_FOUND from the integration', async () => {
    const { gmail, invoke } = setup()
    gmail.remove.mockRejectedValueOnce(new ExposedIpcError('INVALID_INPUT', 'Unknown message'))
    await expect(invoke('gmail:delete', NOTCH, { id: 'x' })).resolves.toEqual({ ok: false, error: { code: 'INVALID_INPUT', message: 'Unknown message' } })
    gmail.message.mockRejectedValueOnce(new ExposedIpcError('NOT_FOUND', 'The message no longer exists'))
    await expect(invoke('gmail:message', NOTCH, { id: 'x' })).resolves.toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    gmail.openLink.mockImplementationOnce(() => {
      throw new ExposedIpcError('INVALID_INPUT', 'Unknown link')
    })
    await expect(invoke('gmail:open-link', NOTCH, { id: 'x', index: 0 })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  })

  it('validates action inputs: ids only, link by index', async () => {
    const { gmail, invoke } = setup()
    await expect(invoke('gmail:delete', NOTCH, {})).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    await expect(invoke('gmail:open-link', NOTCH, { id: 'm1', url: 'https://evil.test' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    await expect(invoke('gmail:open-link', NOTCH, { id: 'm1', index: 50 })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(gmail.remove).not.toHaveBeenCalled()
    expect(gmail.openLink).not.toHaveBeenCalled()
  })

  it('validates the message output: strict, http/https links only', async () => {
    const extra = setup({ detail: { ...detail('m1'), html: '<b>x</b>' } })
    await expect(extra.invoke('gmail:message', NOTCH, { id: 'm1' })).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
    const bad = setup({ detail: { ...detail('m1'), links: [{ text: 'x', url: 'file:///c:/x' }] } })
    await expect(bad.invoke('gmail:message', NOTCH, { id: 'm1' })).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
  })

  it('validates outputs: no extra state fields and at most 5 messages', async () => {
    const extra = setup({ state: { ...okState, token: 'RT' } })
    await expect(extra.invoke('gmail:get-state', NOTCH)).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
    const many = setup({ recent: ['1', '2', '3', '4', '5', '6'].map(msg) })
    await expect(many.invoke('gmail:recent', NOTCH)).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
  })
})
