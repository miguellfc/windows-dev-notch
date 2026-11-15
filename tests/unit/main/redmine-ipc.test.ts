import { describe, expect, it, vi } from 'vitest'
import { ExposedIpcError } from '../../../src/main/ipc/errors'
import { registerIpc, type IpcEventLike, type IpcHandlers, type IpcMainLike } from '../../../src/main/ipc/register'
import { createRedmineIpcHandlers, redmineChannelGuards } from '../../../src/main/redmine/redmine-ipc'
import { contract } from '../../../src/shared/ipc/contract'
import type {
  LogTimeInput,
  RedmineActivity,
  RedmineIssue,
  RedmineIssueDetail,
  RedmineIssueList,
  RedmineSetKeyResult,
  RedmineState,
  RedmineSummaryResult,
  RedmineWriteResult,
  UpdateIssueInput,
} from '../../../src/shared/redmine/schema'
import { createMemoryLogger } from '../helpers/memory-logger'

type Listener = (event: IpcEventLike, ...args: unknown[]) => unknown

const NOTCH = 1
const CONTROL_CENTER = 2
const OTHER = 3
const from = (id: number): IpcEventLike => ({ sender: { id }, senderFrame: { url: 'app://trusted', parent: null } })

const okState: RedmineState = { status: 'ok', account: 'Alice', todayHours: 5.5, updatedAt: 1_763_000_000_000, persistent: true }
const issue: RedmineIssue = {
  id: 12,
  subject: 'T',
  project: 'P',
  status: { id: 2, name: 'In progress' },
  estimatedHours: null,
  spentHours: null,
  updatedOn: '2026-11-12T10:00:00Z',
}
const logEntry: LogTimeInput = { issueId: 12, spentOn: '2026-11-01', hours: 1.5, activityId: 9, comments: 'work' }

function setup(options: { ready?: Promise<void>; state?: unknown; issues?: unknown; setKey?: unknown; write?: unknown; summary?: unknown } = {}) {
  const redmine = {
    ready: options.ready ?? Promise.resolve(),
    state: vi.fn(() => (options.state ?? okState) as RedmineState),
    issues: vi.fn<() => Promise<RedmineIssueList>>(async () => (options.issues ?? { issues: [issue], truncated: false }) as RedmineIssueList),
    issue: vi.fn<(id: number) => Promise<RedmineIssueDetail>>(async () => ({ ...issue, allowedStatuses: [{ id: 3, name: 'Done' }] })),
    activities: vi.fn<() => Promise<RedmineActivity[]>>(async () => [{ id: 9, name: 'Dev', isDefault: true }]),
    updateIssue: vi.fn<(input: UpdateIssueInput) => Promise<RedmineWriteResult>>(async () => (options.write ?? { ok: true }) as RedmineWriteResult),
    logTime: vi.fn<(input: LogTimeInput) => Promise<RedmineWriteResult>>(async () => (options.write ?? { ok: true }) as RedmineWriteResult),
    summary: vi.fn<() => Promise<RedmineSummaryResult>>(async () => (options.summary ?? { summary: null, error: false }) as RedmineSummaryResult),
    setViewOpen: vi.fn<(open: boolean) => void>(),
    refresh: vi.fn(),
    open: vi.fn<(id: number) => void>(),
    setKey: vi.fn<(url: string, key: string) => Promise<RedmineSetKeyResult>>(async () => (options.setKey ?? { ok: true, account: 'Alice' }) as RedmineSetKeyResult),
    clear: vi.fn<() => Promise<void>>(async () => undefined),
  }
  const listeners = new Map<string, Listener>()
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => void listeners.set(channel, listener as Listener),
    removeHandler: (channel) => void listeners.delete(channel),
  }
  registerIpc({
    ipcMain,
    // Only the redmine channels are exercised here.
    handlers: createRedmineIpcHandlers(redmine) as unknown as IpcHandlers,
    isTrustedUrl: (url) => url === 'app://trusted',
    logger: createMemoryLogger(),
    channelGuards: redmineChannelGuards({
      fromNotch: (event) => event.sender.id === NOTCH,
      fromControlCenter: (event) => event.sender.id === CONTROL_CENTER,
    }),
  })
  const invoke = (channel: string, id: number, ...args: unknown[]) => {
    const listener = listeners.get(channel)
    if (!listener) throw new Error(`No handler for ${channel}`)
    return listener(from(id), ...args)
  }
  return { redmine, invoke }
}

const allowed: Record<Extract<keyof typeof contract, `redmine:${string}`>, 'notch' | 'control-center' | 'both'> = {
  'redmine:get-state': 'both',
  'redmine:issues': 'notch',
  'redmine:issue': 'notch',
  'redmine:activities': 'notch',
  'redmine:update-issue': 'notch',
  'redmine:log-time': 'notch',
  'redmine:summary': 'notch',
  'redmine:view': 'notch',
  'redmine:refresh': 'notch',
  'redmine:open': 'notch',
  'redmine:set-key': 'control-center',
  'redmine:clear': 'control-center',
}
const sample: Record<string, unknown> = {
  'redmine:issue': { id: 12 },
  'redmine:update-issue': { id: 12, statusId: 3 },
  'redmine:log-time': logEntry,
  'redmine:view': { open: true },
  'redmine:open': { id: 12 },
  'redmine:set-key': { url: 'https://redmine.example.test', key: 'fake-key' },
}

describe('redmine IPC guards', () => {
  it('covers every redmine channel', () => {
    expect(Object.keys(allowed).sort()).toEqual(Object.keys(contract).filter((c) => c.startsWith('redmine:')).sort())
  })

  it.each(Object.entries(allowed))('%s is reachable only from %s', async (channel, who) => {
    const { invoke } = setup()
    const args = sample[channel] === undefined ? [] : [sample[channel]]
    for (const id of [NOTCH, CONTROL_CENTER, OTHER]) {
      const allowedHere = (who === 'both' && id !== OTHER) || (who === 'notch' && id === NOTCH) || (who === 'control-center' && id === CONTROL_CENTER)
      await expect(invoke(channel, id, ...args)).resolves.toMatchObject(allowedHere ? { ok: true } : { ok: false, error: { code: 'FORBIDDEN' } })
    }
  })

  it('a forbidden caller never reaches the integration', async () => {
    const { redmine, invoke } = setup()
    await invoke('redmine:set-key', NOTCH, sample['redmine:set-key'])
    await invoke('redmine:clear', NOTCH)
    await invoke('redmine:open', CONTROL_CENTER, { id: 12 })
    await invoke('redmine:issues', CONTROL_CENTER)
    await invoke('redmine:update-issue', CONTROL_CENTER, { id: 12, statusId: 3 })
    await invoke('redmine:log-time', CONTROL_CENTER, logEntry)
    expect(redmine.setKey).not.toHaveBeenCalled()
    expect(redmine.clear).not.toHaveBeenCalled()
    expect(redmine.open).not.toHaveBeenCalled()
    expect(redmine.issues).not.toHaveBeenCalled()
    expect(redmine.updateIssue).not.toHaveBeenCalled()
    expect(redmine.logTime).not.toHaveBeenCalled()
  })
})

describe('redmine IPC handlers', () => {
  it('get-state, view, refresh and open wait for the stored key to load', async () => {
    let release: () => void = () => undefined
    const { redmine, invoke } = setup({ ready: new Promise<void>((resolve) => (release = resolve)) })
    const pending = [
      invoke('redmine:get-state', CONTROL_CENTER),
      invoke('redmine:view', NOTCH, { open: true }),
      invoke('redmine:refresh', NOTCH),
      invoke('redmine:open', NOTCH, { id: 12 }),
    ]
    await Promise.resolve()
    expect(redmine.state).not.toHaveBeenCalled()
    expect(redmine.setViewOpen).not.toHaveBeenCalled()
    expect(redmine.refresh).not.toHaveBeenCalled()
    expect(redmine.open).not.toHaveBeenCalled()
    release()
    await expect(Promise.all(pending)).resolves.toEqual([
      { ok: true, data: okState },
      { ok: true, data: null },
      { ok: true, data: null },
      { ok: true, data: null },
    ])
    expect(redmine.setViewOpen).toHaveBeenCalledWith(true)
    expect(redmine.open).toHaveBeenCalledWith(12)
  })

  it('passes reads, writes, set-key and clear through', async () => {
    const { redmine, invoke } = setup()
    await expect(invoke('redmine:issues', NOTCH)).resolves.toEqual({ ok: true, data: { issues: [issue], truncated: false } })
    await expect(invoke('redmine:issue', NOTCH, { id: 12 })).resolves.toMatchObject({ ok: true, data: { id: 12, allowedStatuses: [{ id: 3, name: 'Done' }] } })
    expect(redmine.issue).toHaveBeenCalledWith(12)
    await expect(invoke('redmine:activities', NOTCH)).resolves.toEqual({ ok: true, data: [{ id: 9, name: 'Dev', isDefault: true }] })
    await expect(invoke('redmine:update-issue', NOTCH, { id: 12, estimatedHours: null })).resolves.toEqual({ ok: true, data: { ok: true } })
    expect(redmine.updateIssue).toHaveBeenCalledWith({ id: 12, estimatedHours: null })
    await expect(invoke('redmine:log-time', NOTCH, logEntry)).resolves.toEqual({ ok: true, data: { ok: true } })
    expect(redmine.logTime).toHaveBeenCalledWith(logEntry)
    await expect(invoke('redmine:summary', NOTCH)).resolves.toEqual({ ok: true, data: { summary: null, error: false } })
    await expect(invoke('redmine:set-key', CONTROL_CENTER, { url: 'https://redmine.example.test', key: 'fake-key' })).resolves.toEqual({
      ok: true,
      data: { ok: true, account: 'Alice' },
    })
    expect(redmine.setKey).toHaveBeenCalledWith('https://redmine.example.test', 'fake-key')
    await expect(invoke('redmine:clear', CONTROL_CENTER)).resolves.toEqual({ ok: true, data: null })
    expect(redmine.clear).toHaveBeenCalledOnce()
  })

  it('returns a refused write and a failed key check as data', async () => {
    const forbidden = setup({ write: { ok: false, reason: 'forbidden' } })
    await expect(forbidden.invoke('redmine:update-issue', NOTCH, { id: 12, statusId: 3 })).resolves.toEqual({ ok: true, data: { ok: false, reason: 'forbidden' } })
    const badKey = setup({ setKey: { ok: false, reason: 'auth' } })
    await expect(badKey.invoke('redmine:set-key', CONTROL_CENTER, { url: 'https://redmine.example.test', key: 'k' })).resolves.toEqual({
      ok: true,
      data: { ok: false, reason: 'auth' },
    })
  })

  it('exposes INVALID_INPUT from open (unknown id or origin)', async () => {
    const { redmine, invoke } = setup()
    redmine.open.mockImplementationOnce(() => {
      throw new ExposedIpcError('INVALID_INPUT', 'Unknown issue')
    })
    await expect(invoke('redmine:open', NOTCH, { id: 99 })).resolves.toEqual({ ok: false, error: { code: 'INVALID_INPUT', message: 'Unknown issue' } })
  })

  it('validates inputs: ids only (never a URL), bounded hours, dates and keys', async () => {
    const { redmine, invoke } = setup()
    const invalid = { ok: false, error: { code: 'INVALID_INPUT' } }
    await expect(invoke('redmine:open', NOTCH, { id: 12, url: 'https://evil.test' })).resolves.toMatchObject(invalid)
    await expect(invoke('redmine:open', NOTCH, { id: 0 })).resolves.toMatchObject(invalid)
    await expect(invoke('redmine:issue', NOTCH, { id: '12' })).resolves.toMatchObject(invalid)
    await expect(invoke('redmine:update-issue', NOTCH, { id: 12 })).resolves.toMatchObject(invalid)
    await expect(invoke('redmine:update-issue', NOTCH, { id: 12, estimatedHours: 1.234 })).resolves.toMatchObject(invalid)
    await expect(invoke('redmine:log-time', NOTCH, { ...logEntry, hours: 24.01 })).resolves.toMatchObject(invalid)
    await expect(invoke('redmine:log-time', NOTCH, { ...logEntry, hours: 0 })).resolves.toMatchObject(invalid)
    await expect(invoke('redmine:log-time', NOTCH, { ...logEntry, spentOn: '2999-01-01' })).resolves.toMatchObject(invalid)
    await expect(invoke('redmine:log-time', NOTCH, { ...logEntry, comments: 'x'.repeat(256) })).resolves.toMatchObject(invalid)
    await expect(invoke('redmine:refresh', NOTCH, { force: true })).resolves.toMatchObject(invalid)
    await expect(invoke('redmine:view', NOTCH, {})).resolves.toMatchObject(invalid)
    await expect(invoke('redmine:set-key', CONTROL_CENTER, { url: 'https://redmine.example.test', key: '' })).resolves.toMatchObject(invalid)
    await expect(invoke('redmine:set-key', CONTROL_CENTER, { url: 'https://redmine.example.test', key: 'x'.repeat(256) })).resolves.toMatchObject(invalid)
    await expect(invoke('redmine:clear', CONTROL_CENTER, {})).resolves.toMatchObject(invalid)
    expect(redmine.open).not.toHaveBeenCalled()
    expect(redmine.issue).not.toHaveBeenCalled()
    expect(redmine.updateIssue).not.toHaveBeenCalled()
    expect(redmine.logTime).not.toHaveBeenCalled()
    expect(redmine.refresh).not.toHaveBeenCalled()
    expect(redmine.setViewOpen).not.toHaveBeenCalled()
    expect(redmine.setKey).not.toHaveBeenCalled()
    expect(redmine.clear).not.toHaveBeenCalled()
  })

  it('validates outputs: strict state (no key), no URLs in lists, strict key result', async () => {
    const internal = { ok: false, error: { code: 'INTERNAL' } }
    await expect(setup({ state: { ...okState, key: 'secret' } }).invoke('redmine:get-state', NOTCH)).resolves.toMatchObject(internal)
    await expect(setup({ issues: { issues: [{ ...issue, url: 'https://redmine.example.test/issues/12' }], truncated: false } }).invoke('redmine:issues', NOTCH)).resolves.toMatchObject(
      internal,
    )
    await expect(
      setup({ setKey: { ok: true, account: 'Alice', key: 'secret' } }).invoke('redmine:set-key', CONTROL_CENTER, { url: 'https://redmine.example.test', key: 'k' }),
    ).resolves.toMatchObject(internal)
  })
})
