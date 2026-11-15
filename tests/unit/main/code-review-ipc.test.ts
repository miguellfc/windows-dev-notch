import { describe, expect, it, vi } from 'vitest'
import { codeReviewChannelGuards, createCodeReviewIpcHandlers } from '../../../src/main/code-review/code-review-ipc'
import { registerIpc, type IpcEventLike, type IpcHandlers, type IpcMainLike } from '../../../src/main/ipc/register'
import { ExposedIpcError } from '../../../src/main/ipc/errors'
import type { CodeReviewList, CodeReviewState, ContributionsResult, Platform, ReviewItem, SetTokenResult } from '../../../src/shared/code-review/schema'
import { contract } from '../../../src/shared/ipc/contract'
import { createMemoryLogger } from '../helpers/memory-logger'

type Listener = (event: IpcEventLike, ...args: unknown[]) => unknown

const NOTCH = 1
const CONTROL_CENTER = 2
const OTHER = 3
const from = (id: number): IpcEventLike => ({ sender: { id }, senderFrame: { url: 'app://trusted', parent: null } })

const platformState = { status: 'ok', account: 'me', unreviewed: 2, updatedAt: '2026-11-13T10:00:00.000Z', persistent: true } as const
const okState: CodeReviewState = { github: platformState, gitlab: { ...platformState, status: 'unconfigured', account: null, unreviewed: null, updatedAt: null } }
const item = (id: string): ReviewItem => ({
  id,
  ref: 'o/r#1',
  title: 'T',
  author: 'a',
  updatedAt: '2026-11-13T09:00:00.000Z',
  draft: false,
  review: 'none',
  checks: null,
  conflicts: false,
})

function setup(options: { ready?: Promise<void>; state?: unknown; list?: unknown; setToken?: unknown; contributions?: unknown } = {}) {
  const codeReview = {
    ready: options.ready ?? Promise.resolve(),
    state: vi.fn(() => (options.state ?? okState) as CodeReviewState),
    list: vi.fn<(platform: Platform) => Promise<CodeReviewList>>(async () => (options.list ?? { toReview: [item('a')], mine: [] }) as CodeReviewList),
    refresh: vi.fn(),
    open: vi.fn<(platform: Platform, id: string) => void>(),
    setToken: vi.fn<(platform: Platform, token: string, url?: string) => Promise<SetTokenResult>>(
      async () => (options.setToken ?? { ok: true, account: 'me' }) as SetTokenResult,
    ),
    clear: vi.fn<(platform: Platform) => Promise<void>>(async () => undefined),
    setViewOpen: vi.fn<(open: boolean) => void>(),
    contributions: vi.fn<(platform: Platform) => Promise<ContributionsResult>>(
      async () => (options.contributions ?? { summary: null, error: false }) as ContributionsResult,
    ),
  }
  const listeners = new Map<string, Listener>()
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => void listeners.set(channel, listener as Listener),
    removeHandler: (channel) => void listeners.delete(channel),
  }
  registerIpc({
    ipcMain,
    // Only the code-review channels are exercised here.
    handlers: createCodeReviewIpcHandlers(codeReview) as unknown as IpcHandlers,
    isTrustedUrl: (url) => url === 'app://trusted',
    logger: createMemoryLogger(),
    channelGuards: codeReviewChannelGuards({
      fromNotch: (event) => event.sender.id === NOTCH,
      fromControlCenter: (event) => event.sender.id === CONTROL_CENTER,
    }),
  })
  const invoke = (channel: string, id: number, ...args: unknown[]) => {
    const listener = listeners.get(channel)
    if (!listener) throw new Error(`No handler for ${channel}`)
    return listener(from(id), ...args)
  }
  return { codeReview, invoke }
}

const allowed: Record<Extract<keyof typeof contract, `code-review:${string}`>, 'notch' | 'control-center' | 'both'> = {
  'code-review:get-state': 'both',
  'code-review:list': 'notch',
  'code-review:refresh': 'notch',
  'code-review:open': 'notch',
  'code-review:set-token': 'control-center',
  'code-review:clear': 'control-center',
  'code-review:view': 'notch',
  'code-review:contributions': 'notch',
}
const sample: Record<string, unknown> = {
  'code-review:list': { platform: 'github' },
  'code-review:open': { platform: 'github', id: 'a' },
  'code-review:set-token': { platform: 'github', token: 'fake-token' },
  'code-review:clear': { platform: 'gitlab' },
  'code-review:view': { open: true },
  'code-review:contributions': { platform: 'github' },
}

describe('code review IPC guards', () => {
  it('covers every code-review channel', () => {
    expect(Object.keys(allowed).sort()).toEqual(Object.keys(contract).filter((c) => c.startsWith('code-review:')).sort())
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
    const { codeReview, invoke } = setup()
    await invoke('code-review:set-token', NOTCH, { platform: 'github', token: 'fake-token' })
    await invoke('code-review:clear', NOTCH, { platform: 'github' })
    await invoke('code-review:open', CONTROL_CENTER, { platform: 'github', id: 'a' })
    await invoke('code-review:list', CONTROL_CENTER, { platform: 'github' })
    expect(codeReview.setToken).not.toHaveBeenCalled()
    expect(codeReview.clear).not.toHaveBeenCalled()
    expect(codeReview.open).not.toHaveBeenCalled()
    expect(codeReview.list).not.toHaveBeenCalled()
    await invoke('code-review:view', CONTROL_CENTER, { open: true })
    await invoke('code-review:contributions', CONTROL_CENTER, { platform: 'github' })
    expect(codeReview.setViewOpen).not.toHaveBeenCalled()
    expect(codeReview.contributions).not.toHaveBeenCalled()
  })
})

describe('code review IPC handlers', () => {
  it('get-state waits for the stored tokens to load', async () => {
    let release: () => void = () => undefined
    const { codeReview, invoke } = setup({ ready: new Promise<void>((resolve) => (release = resolve)) })
    const pending = invoke('code-review:get-state', CONTROL_CENTER)
    await Promise.resolve()
    expect(codeReview.state).not.toHaveBeenCalled()
    release()
    await expect(pending).resolves.toEqual({ ok: true, data: okState })
  })

  it('passes list, refresh, open, set-token and clear through', async () => {
    const { codeReview, invoke } = setup()
    await expect(invoke('code-review:list', NOTCH, { platform: 'gitlab' })).resolves.toEqual({ ok: true, data: { toReview: [item('a')], mine: [] } })
    expect(codeReview.list).toHaveBeenCalledWith('gitlab')
    await expect(invoke('code-review:refresh', NOTCH)).resolves.toEqual({ ok: true, data: null })
    expect(codeReview.refresh).toHaveBeenCalledOnce()
    await expect(invoke('code-review:open', NOTCH, { platform: 'github', id: 'a' })).resolves.toEqual({ ok: true, data: null })
    expect(codeReview.open).toHaveBeenCalledWith('github', 'a')
    await expect(invoke('code-review:set-token', CONTROL_CENTER, { platform: 'gitlab', token: 'fake-token', url: 'https://gitlab.example.test' })).resolves.toEqual({
      ok: true,
      data: { ok: true, account: 'me' },
    })
    expect(codeReview.setToken).toHaveBeenCalledWith('gitlab', 'fake-token', 'https://gitlab.example.test')
    await expect(invoke('code-review:clear', CONTROL_CENTER, { platform: 'gitlab' })).resolves.toEqual({ ok: true, data: null })
    expect(codeReview.clear).toHaveBeenCalledWith('gitlab')
  })

  it('returns a failed token check as data', async () => {
    const { invoke } = setup({ setToken: { ok: false, reason: 'url' } })
    await expect(invoke('code-review:set-token', CONTROL_CENTER, { platform: 'gitlab', token: 'fake-token', url: 'http://x' })).resolves.toEqual({
      ok: true,
      data: { ok: false, reason: 'url' },
    })
  })

  it('exposes INVALID_INPUT from open (unknown id or origin)', async () => {
    const { codeReview, invoke } = setup()
    codeReview.open.mockImplementationOnce(() => {
      throw new ExposedIpcError('INVALID_INPUT', 'Unknown item')
    })
    await expect(invoke('code-review:open', NOTCH, { platform: 'github', id: 'zz' })).resolves.toEqual({
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'Unknown item' },
    })
  })

  it('validates inputs: ids only (never a URL), known platforms, bounded tokens', async () => {
    const { codeReview, invoke } = setup()
    const invalid = { ok: false, error: { code: 'INVALID_INPUT' } }
    await expect(invoke('code-review:open', NOTCH, { platform: 'github', id: 'a', url: 'https://evil.test' })).resolves.toMatchObject(invalid)
    await expect(invoke('code-review:open', NOTCH, { platform: 'bitbucket', id: 'a' })).resolves.toMatchObject(invalid)
    await expect(invoke('code-review:open', NOTCH, { platform: 'github', id: '' })).resolves.toMatchObject(invalid)
    await expect(invoke('code-review:list', NOTCH, {})).resolves.toMatchObject(invalid)
    await expect(invoke('code-review:refresh', NOTCH, { force: true })).resolves.toMatchObject(invalid)
    await expect(invoke('code-review:get-state', NOTCH, {})).resolves.toMatchObject(invalid)
    await expect(invoke('code-review:set-token', CONTROL_CENTER, { platform: 'github', token: '' })).resolves.toMatchObject(invalid)
    await expect(invoke('code-review:set-token', CONTROL_CENTER, { platform: 'github', token: 'x'.repeat(256) })).resolves.toMatchObject(invalid)
    await expect(invoke('code-review:set-token', CONTROL_CENTER, { platform: 'github', token: 't', extra: 1 })).resolves.toMatchObject(invalid)
    await expect(invoke('code-review:clear', CONTROL_CENTER, {})).resolves.toMatchObject(invalid)
    expect(codeReview.open).not.toHaveBeenCalled()
    expect(codeReview.list).not.toHaveBeenCalled()
    expect(codeReview.refresh).not.toHaveBeenCalled()
    expect(codeReview.setToken).not.toHaveBeenCalled()
    expect(codeReview.clear).not.toHaveBeenCalled()
  })

  it('validates outputs: strict state (no token), no URLs in lists, at most 20 items, strict token result', async () => {
    const internal = { ok: false, error: { code: 'INTERNAL' } }
    const tokenInState = setup({ state: { ...okState, github: { ...platformState, token: 'secret' } } })
    await expect(tokenInState.invoke('code-review:get-state', NOTCH)).resolves.toMatchObject(internal)
    const urlInList = setup({ list: { toReview: [{ ...item('a'), url: 'https://github.com/o/r/pull/1' }], mine: [] } })
    await expect(urlInList.invoke('code-review:list', NOTCH, { platform: 'github' })).resolves.toMatchObject(internal)
    const tooMany = setup({ list: { toReview: Array.from({ length: 21 }, (_, i) => item(String(i))), mine: [] } })
    await expect(tooMany.invoke('code-review:list', NOTCH, { platform: 'github' })).resolves.toMatchObject(internal)
    const tokenBack = setup({ setToken: { ok: true, account: 'me', token: 'secret' } })
    await expect(tokenBack.invoke('code-review:set-token', CONTROL_CENTER, { platform: 'github', token: 'fake-token' })).resolves.toMatchObject(internal)
  })

  it('view waits for the stored tokens, then passes open/close through', async () => {
    let release: () => void = () => undefined
    const { codeReview, invoke } = setup({ ready: new Promise<void>((resolve) => (release = resolve)) })
    const pending = invoke('code-review:view', NOTCH, { open: true })
    await Promise.resolve()
    expect(codeReview.setViewOpen).not.toHaveBeenCalled()
    release()
    await expect(pending).resolves.toEqual({ ok: true, data: null })
    expect(codeReview.setViewOpen).toHaveBeenCalledWith(true)
    await invoke('code-review:view', NOTCH, { open: false })
    expect(codeReview.setViewOpen).toHaveBeenLastCalledWith(false)
    await expect(invoke('code-review:view', NOTCH, {})).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  })

  it('contributions returns the cached summary (or null) and the error flag, validated strictly', async () => {
    const { codeReview, invoke } = setup()
    await expect(invoke('code-review:contributions', NOTCH, { platform: 'gitlab' })).resolves.toEqual({ ok: true, data: { summary: null, error: false } })
    expect(codeReview.contributions).toHaveBeenCalledWith('gitlab')
    await expect(invoke('code-review:contributions', NOTCH, { platform: 'bitbucket' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    const failed = setup({ contributions: { summary: null, error: true } })
    await expect(failed.invoke('code-review:contributions', NOTCH, { platform: 'github' })).resolves.toEqual({ ok: true, data: { summary: null, error: true } })
    const leaky = setup({ contributions: { summary: { month: '2026-11', repo: 'acme/secret' }, error: false } })
    await expect(leaky.invoke('code-review:contributions', NOTCH, { platform: 'github' })).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
  })
})
