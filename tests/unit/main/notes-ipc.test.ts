import { describe, expect, it, vi } from 'vitest'
import { ExposedIpcError } from '../../../src/main/ipc/errors'
import { registerIpc, type IpcEventLike, type IpcHandlers, type IpcMainLike } from '../../../src/main/ipc/register'
import { createNotesIpcHandlers, notesChannelGuards } from '../../../src/main/notes/notes-ipc'
import type { NotesService } from '../../../src/main/notes/notes-service'
import { contract } from '../../../src/shared/ipc/contract'
import type { Note } from '../../../src/shared/notes/schema'
import { createMemoryLogger } from '../helpers/memory-logger'

const ID = '3f2c8a1e-5b7d-4c9e-8f10-2a3b4c5d6e7f'
const OTHER_ID = '9a8b7c6d-1e2f-4a3b-8c4d-5e6f7a8b9c0d'
const note: Note = { id: ID, text: 'Revisar PR', pinned: false, createdAt: '2026-11-10T09:00:00.000Z', updatedAt: '2026-11-10T09:00:00.000Z' }

type Listener = (event: IpcEventLike, ...args: unknown[]) => unknown

function fakeService() {
  const texts: Record<string, string> = { [ID]: 'Revisar PR', [OTHER_ID]: 'Otra nota' }
  return {
    create: vi.fn(async () => note),
    update: vi.fn(async () => ({ ...note, text: 'Otro' })),
    setPinned: vi.fn(async () => ({ ...note, pinned: true })),
    remove: vi.fn(async () => note),
    restore: vi.fn(async () => note),
    text: vi.fn((id: string) => {
      const text = texts[id]
      if (text === undefined) throw new ExposedIpcError('NOT_FOUND', 'Note not found')
      return text
    }),
  } satisfies Partial<NotesService>
}

const NOTCH = 1
const CONTROL_CENTER = 2
const OTHER = 3
const from = (id: number): IpcEventLike => ({ sender: { id }, senderFrame: { url: 'app://trusted', parent: null } })

function setup(ready?: () => Promise<void>, notice: 'quarantined' | 'read-only' | null = null) {
  const service = fakeService()
  const writeClipboard = vi.fn()
  const listeners = new Map<string, Listener>()
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => void listeners.set(channel, listener as Listener),
    removeHandler: (channel) => void listeners.delete(channel),
  }
  registerIpc({
    ipcMain,
    handlers: createNotesIpcHandlers(service, () => ({ notes: [note], notice }), writeClipboard, ready) as unknown as IpcHandlers,
    isTrustedUrl: (url) => url === 'app://trusted',
    channelGuards: notesChannelGuards({ fromNotch: (event) => event.sender.id === NOTCH }),
    logger: createMemoryLogger(),
  })
  const invoke = (channel: string, sender: number, ...args: unknown[]) => listeners.get(channel)!(from(sender), ...args)
  return { service, writeClipboard, invoke }
}

const untouched = (service: ReturnType<typeof fakeService>, writeClipboard: ReturnType<typeof vi.fn>) =>
  [service.create, service.update, service.setPinned, service.remove, service.restore, service.text, writeClipboard] as const

describe('notes IPC handlers', () => {
  it('lists notes with the store notice', async () => {
    const { invoke } = setup(undefined, 'read-only')
    await expect(invoke('notes:list', NOTCH)).resolves.toEqual({ ok: true, data: { notes: [note], notice: 'read-only' } })
  })

  it('passes each call to the service', async () => {
    const { invoke, service } = setup()
    await expect(invoke('notes:create', NOTCH, { text: 'Revisar PR' })).resolves.toEqual({ ok: true, data: note })
    expect(service.create).toHaveBeenCalledWith('Revisar PR')
    await expect(invoke('notes:update', NOTCH, { id: ID, text: 'Otro' })).resolves.toMatchObject({ ok: true, data: { text: 'Otro' } })
    expect(service.update).toHaveBeenCalledWith(ID, 'Otro')
    await expect(invoke('notes:pin', NOTCH, { id: ID, pinned: true })).resolves.toMatchObject({ ok: true, data: { pinned: true } })
    expect(service.setPinned).toHaveBeenCalledWith(ID, true)
    await expect(invoke('notes:delete', NOTCH, { id: ID })).resolves.toEqual({ ok: true, data: note })
    expect(service.remove).toHaveBeenCalledWith(ID)
    await expect(invoke('notes:restore', NOTCH, { id: ID })).resolves.toEqual({ ok: true, data: note })
    expect(service.restore).toHaveBeenCalledWith(ID)
  })

  it('copies the text main holds for that id, never text from the renderer', async () => {
    const { invoke, writeClipboard, service } = setup()
    await expect(invoke('notes:copy', NOTCH, { id: OTHER_ID })).resolves.toEqual({ ok: true, data: null })
    expect(service.text).toHaveBeenCalledWith(OTHER_ID)
    expect(writeClipboard).toHaveBeenCalledTimes(1)
    expect(writeClipboard).toHaveBeenCalledWith('Otra nota')
    // A text field is not part of the input: it is rejected.
    await expect(invoke('notes:copy', NOTCH, { id: ID, text: 'evil' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(writeClipboard).toHaveBeenCalledTimes(1)
  })

  it('does not touch the clipboard when the note does not exist', async () => {
    const { invoke, writeClipboard } = setup()
    await expect(invoke('notes:copy', NOTCH, { id: '11111111-2222-4333-8444-555555555555' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    })
    expect(writeClipboard).not.toHaveBeenCalled()
  })

  it('rejects invalid inputs with INVALID_INPUT before reaching the service', async () => {
    const { invoke, service, writeClipboard } = setup()
    const bad: [string, unknown][] = [
      ['notes:create', { text: '' }],
      ['notes:create', { text: 'x'.repeat(2001) }],
      ['notes:create', { text: 'a' + String.fromCharCode(0) + 'b' }],
      ['notes:create', undefined],
      ['notes:update', { id: ID }],
      ['notes:update', { id: 'nope', text: 'x' }],
      ['notes:pin', { id: ID, pinned: 'yes' }],
      ['notes:delete', { id: 'not-a-uuid' }],
      ['notes:restore', { id: ID, extra: true }],
      ['notes:copy', undefined],
    ]
    for (const [channel, input] of bad) {
      expect(await invoke(channel, NOTCH, input), channel).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    }
    for (const fn of untouched(service, writeClipboard)) expect(fn).not.toHaveBeenCalled()
  })

  it('forwards service refusals as their codes', async () => {
    const { invoke, service } = setup()
    service.restore.mockRejectedValueOnce(new ExposedIpcError('NOT_FOUND', 'Note not found'))
    await expect(invoke('notes:restore', NOTCH, { id: ID })).resolves.toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('waits for the ready gate before answering list or mutating', async () => {
    let open: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const { invoke, service } = setup(() => gate)
    const listed = vi.fn()
    const list = Promise.resolve(invoke('notes:list', NOTCH)).then(listed)
    const create = Promise.resolve(invoke('notes:create', NOTCH, { text: 'x' }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(listed).not.toHaveBeenCalled()
    expect(service.create).not.toHaveBeenCalled()
    open()
    await list
    await create
    expect(listed).toHaveBeenCalledWith({ ok: true, data: { notes: [note], notice: null } })
    expect(service.create).toHaveBeenCalledTimes(1)
  })
})

describe('notes channel guards', () => {
  const sample: Record<string, unknown> = {
    'notes:list': undefined,
    'notes:create': { text: 'Hola' },
    'notes:update': { id: ID, text: 'Otro' },
    'notes:pin': { id: ID, pinned: true },
    'notes:delete': { id: ID },
    'notes:restore': { id: ID },
    'notes:copy': { id: ID },
  }
  const noteChannels = Object.keys(contract).filter((name) => name.startsWith('notes:'))

  it('covers every notes channel', () => {
    expect(Object.keys(sample).sort()).toEqual([...noteChannels].sort())
    expect(Object.keys(notesChannelGuards({ fromNotch: () => true })).sort()).toEqual([...noteChannels].sort())
  })

  it.each(noteChannels)('%s answers only the notch: the Control Center and others get FORBIDDEN', async (channel) => {
    const { invoke, service, writeClipboard } = setup()
    const args = sample[channel] === undefined ? [] : [sample[channel]]
    for (const sender of [CONTROL_CENTER, OTHER]) {
      await expect(invoke(channel, sender, ...args)).resolves.toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    for (const fn of untouched(service, writeClipboard)) expect(fn).not.toHaveBeenCalled()
    await expect(invoke(channel, NOTCH, ...args)).resolves.toMatchObject({ ok: true })
  })
})
