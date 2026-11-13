import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { GmailAuthError } from '../../../src/main/gmail/auth-error'
import { createGmailAuth, type GmailAuth, type GmailFetch, type SignInResult } from '../../../src/main/gmail/gmail-auth'
import { GmailApiError, type GmailClient } from '../../../src/main/gmail/gmail-client'
import { ExposedIpcError } from '../../../src/main/ipc/errors'
import {
  createGmailIntegration,
  parseGmailBaseOverride,
  type GmailClientAccess,
} from '../../../src/main/gmail/gmail-integration'
import type { GmailMessage, GmailMessageDetail, GmailNewMail, GmailState } from '../../../src/shared/gmail/schema'
import { DEFAULT_GMAIL_ALERTS, type GmailSettings } from '../../../src/shared/settings/schema'
import { createNotchController, type NotchSurface } from '../../../src/main/windows/notch-controller'
import type { NotchEvent } from '../../../src/shared/notch/state'
import { createMemoryLogger } from '../helpers/memory-logger'

const MIN = 60_000

type FakeAuth = { [K in keyof GmailAuth]: Mock<GmailAuth[K]> }
const message = (id: string, extra: Partial<GmailMessage> = {}): GmailMessage => ({
  id,
  threadId: `thread-${id}`,
  from: `Sender ${id}`,
  subject: `Subject ${id}`,
  snippet: `Snippet ${id}`,
  date: '2026-11-11T09:00:00.000Z',
  unread: true,
  ...extra,
})

/** Unread ids as the client returns them: `count` ids, newest first. */
const ids = (count: number, prefix = 'u'): string[] => Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`)

const detail = (id: string, extra: Partial<GmailMessageDetail> = {}): GmailMessageDetail => ({
  id,
  threadId: `thread-${id}`,
  from: `Sender ${id}`,
  fromAddress: `${id}@example.com`,
  subject: `Subject ${id}`,
  date: '2026-11-11T09:00:00.000Z',
  unread: true,
  body: `Body ${id}`,
  truncated: false,
  links: [
    { text: 'First', url: `https://example.com/${id}/1` },
    { text: 'Second', url: `https://example.com/${id}/2` },
  ],
  attachments: 0,
  ...extra,
})

interface SetupOptions {
  clientId?: string
  token?: string | null
  persistent?: boolean
  /** Calls `start()` (default true), as main does once the IPC targets exist. */
  started?: boolean
  /** Also called for each new-mail alert (main dispatches it to the notch). */
  onNewMail?: (mail: GmailNewMail) => void
  /** Adjusts each fake auth as it is created (e.g. a failing refresh). */
  prepareAuth?: (auth: FakeAuth) => void
}

function setup(options: SetupOptions = {}) {
  vi.useFakeTimers({ now: new Date('2026-11-11T10:00:00.000Z') })
  const logger = createMemoryLogger()

  let current: { gmail: GmailSettings } = { gmail: { clientId: options.clientId ?? 'cid', clientSecret: 'csecret', alerts: { ...DEFAULT_GMAIL_ALERTS } } }
  const listeners = new Set<(s: typeof current) => void>()
  const settings = {
    get: () => current,
    onChange: (listener: (s: typeof current) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const changeSettings = (credentials: { clientId: string; clientSecret: string }) => {
    current = { gmail: { ...credentials, alerts: { ...current.gmail.alerts } } }
    for (const listener of listeners) listener(current)
  }
  const setAlerts = (alerts: Partial<GmailSettings['alerts']>) => {
    current = { gmail: { ...current.gmail, alerts: { ...current.gmail.alerts, ...alerts } } }
    for (const listener of listeners) listener(current)
  }

  let stored: string | null = options.token === undefined ? 'RT-stored' : options.token
  const tokenStore = {
    load: vi.fn(async () => stored),
    save: vi.fn(async (token: string) => {
      stored = token
    }),
    clear: vi.fn(async () => {
      stored = null
    }),
    persistent: options.persistent ?? true,
  }

  // Fake auth that behaves like the real one: a second signIn cancels the first.
  let pendingSignIn: { resolve: (r: SignInResult) => void; reject: (e: unknown) => void } | null = null
  const makeAuth = (): FakeAuth => ({
    signIn: vi.fn<GmailAuth['signIn']>(
      () =>
        new Promise<SignInResult>((resolve, reject) => {
          pendingSignIn?.reject(new GmailAuthError('cancelled'))
          pendingSignIn = { resolve, reject }
        }),
    ),
    cancel: vi.fn<GmailAuth['cancel']>(() => {
      pendingSignIn?.reject(new GmailAuthError('cancelled'))
      pendingSignIn = null
    }),
    refresh: vi.fn<GmailAuth['refresh']>(async () => ({ accessToken: 'AT-refreshed', expiresAt: Date.now() + 3_600_000 })),
    revoke: vi.fn<GmailAuth['revoke']>(async () => undefined),
  })
  const auths: ReturnType<typeof makeAuth>[] = []
  const authFactory = vi.fn<(creds: { clientId: string; clientSecret: string }) => FakeAuth>(() => {
    const auth = makeAuth()
    options.prepareAuth?.(auth)
    auths.push(auth)
    return auth
  })
  const finishSignIn = (result: Partial<SignInResult> = {}) => {
    pendingSignIn?.resolve({ refreshToken: 'RT-new', accessToken: 'AT-new', expiresAt: Date.now() + 3_600_000, ...result })
    pendingSignIn = null
  }
  const failSignIn = (code: GmailAuthError['code']) => {
    pendingSignIn?.reject(new GmailAuthError(code))
    pendingSignIn = null
  }

  let list = [message('m1'), message('m2')]
  const api = {
    profile: vi.fn(async () => 'me@example.com'),
    unreadIds: vi.fn(async () => ids(3)),
    recent: vi.fn(async () => list),
    summary: vi.fn(async (id: string): Promise<GmailMessage | null> => message(id)),
    message: vi.fn(async (id: string) => detail(id)),
    markRead: vi.fn<(id: string) => Promise<void>>(async () => undefined),
    remove: vi.fn<(id: string) => Promise<void>>(async () => undefined),
  }
  const tokensUsed: string[] = []
  let access: GmailClientAccess | null = null
  const clientFactory = vi.fn((deps: GmailClientAccess): GmailClient => {
    access = deps
    const call =
      <A extends unknown[], T>(fn: (...args: A) => Promise<T>) =>
      async (...args: A) => {
        tokensUsed.push(await deps.getAccessToken())
        return fn(...args)
      }
    return {
      profile: call(() => api.profile()),
      unreadIds: call(() => api.unreadIds()),
      recent: call(() => api.recent()),
      summary: call((id: string) => api.summary(id)),
      message: call((id: string) => api.message(id)),
      markRead: call((id: string) => api.markRead(id)),
      remove: call((id: string) => api.remove(id)),
    }
  })

  const states: GmailState[] = []
  const openExternal = vi.fn()
  const newMail: GmailNewMail[] = []
  const gmail = createGmailIntegration({
    settings,
    tokenStore,
    authFactory,
    clientFactory,
    timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
    now: () => Date.now(),
    emit: (state) => states.push(state),
    openExternal,
    onNewMail: (mail) => {
      newMail.push(mail)
      options.onNewMail?.(mail)
    },
    logger,
  })
  if (options.started ?? true) gmail.start()

  const requests = () => Object.values(api).reduce((sum, fn) => sum + fn.mock.calls.length, 0)
  return {
    gmail,
    api,
    auths,
    authFactory,
    clientFactory,
    tokenStore,
    states,
    openExternal,
    logger,
    changeSettings,
    setAlerts,
    newMail,
    finishSignIn,
    failSignIn,
    requests,
    tokensUsed,
    access: () => access!,
    setList: (next: GmailMessage[]) => {
      list = next
    },
    stored: () => stored,
  }
}

const flush = () => vi.advanceTimersByTimeAsync(0)

afterEach(() => {
  vi.useRealTimers()
})

describe('gmail integration: startup', () => {
  it('without a client id is unconfigured and makes no request', async () => {
    const t = setup({ clientId: '' })
    await t.gmail.ready
    await flush()
    expect(t.gmail.state()).toEqual({ status: 'unconfigured', account: null, unread: null, updatedAt: null, persistent: true, reason: null })
    expect(t.requests()).toBe(0)
    expect(t.authFactory).not.toHaveBeenCalled()
  })

  it('with a client and no token is signed-out', async () => {
    const t = setup({ token: null })
    await t.gmail.ready
    await flush()
    expect(t.gmail.state().status).toBe('signed-out')
    expect(t.requests()).toBe(0)
  })

  it('with a token queries and reports ok with unread, account and updatedAt', async () => {
    const t = setup({ persistent: false })
    await t.gmail.ready
    await flush()
    expect(t.gmail.state()).toEqual({
      status: 'ok',
      account: 'me@example.com',
      unread: 3,
      updatedAt: '2026-11-11T10:00:00.000Z',
      persistent: false,
      reason: null,
    })
    expect(t.auths[0]!.refresh).toHaveBeenCalledWith('RT-stored')
    expect(t.states.at(-1)).toEqual(t.gmail.state())
  })

  it('without network at startup, with a token, is offline (not expired) and recovers', async () => {
    const t = setup({ prepareAuth: (a) => a.refresh.mockRejectedValue(new GmailAuthError('network')) })
    const auth = () => t.auths[0]!
    await t.gmail.ready
    await flush()
    expect(t.gmail.state().status).toBe('offline')
    expect(t.tokenStore.clear).not.toHaveBeenCalled()

    auth().refresh.mockResolvedValue({ accessToken: 'AT-back', expiresAt: Date.now() + 3_600_000 })
    await vi.advanceTimersByTimeAsync(MIN)
    expect(t.gmail.state()).toMatchObject({ status: 'ok', unread: 3 })
  })

  it('does not query before it is started', async () => {
    const t = setup({ started: false })
    await t.gmail.ready
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(t.requests()).toBe(0)
    expect(t.gmail.state().status).toBe('ok')
  })
})

describe('gmail integration: rhythm', () => {
  it('ticks every 60 s for as long as it runs (whatever the capsule shows), asking the account once', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    expect(t.api.unreadIds).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(MIN - 1)
    expect(t.api.unreadIds).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(t.api.unreadIds).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(t.api.unreadIds).toHaveBeenCalledTimes(12)
    // A second start changes nothing (no extra query, no second timer).
    t.gmail.start()
    await flush()
    expect(t.api.unreadIds).toHaveBeenCalledTimes(12)
    await vi.advanceTimersByTimeAsync(MIN)
    expect(t.api.unreadIds).toHaveBeenCalledTimes(13)
    expect(t.api.recent).not.toHaveBeenCalled()
    expect(t.api.profile).toHaveBeenCalledTimes(1) // the account is asked once
  })

  it('with the view open also fetches the recent list, on open and on every tick', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    t.gmail.setViewOpen(true)
    await flush()
    expect(t.api.recent).toHaveBeenCalledTimes(1)
    await expect(t.gmail.recent()).resolves.toEqual([message('m1'), message('m2')])
    await vi.advanceTimersByTimeAsync(MIN)
    expect(t.api.recent).toHaveBeenCalledTimes(2)

    t.gmail.setViewOpen(false)
    await vi.advanceTimersByTimeAsync(MIN)
    expect(t.api.recent).toHaveBeenCalledTimes(2)
    expect(t.api.unreadIds).toHaveBeenCalledTimes(4)
  })

  it('a manual refresh queries at once, at most once per 5 s', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(t.api.unreadIds).toHaveBeenCalledTimes(1)
    t.gmail.refresh()
    await flush()
    t.gmail.refresh()
    await flush()
    expect(t.api.unreadIds).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5_000)
    t.gmail.refresh()
    await flush()
    expect(t.api.unreadIds).toHaveBeenCalledTimes(3)
  })

  it('refreshes the access token only when missing or within 60 s of expiry; a 401 forces one', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    const auth = t.auths[0]!
    expect(auth.refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(auth.refresh).toHaveBeenCalledTimes(1)
    expect(new Set(t.tokensUsed)).toEqual(new Set(['AT-refreshed']))

    auth.refresh.mockResolvedValueOnce({ accessToken: 'AT-forced', expiresAt: Date.now() + 3_600_000 })
    await expect(t.access().onUnauthorized()).resolves.toBe(true)
    expect(auth.refresh).toHaveBeenCalledTimes(2)
    await expect(t.access().getAccessToken()).resolves.toBe('AT-forced')

    auth.refresh.mockResolvedValueOnce({ accessToken: 'AT-short', expiresAt: Date.now() + 30_000 })
    await t.access().onUnauthorized()
    // Inside the 60 s margin: the next use refreshes again.
    await expect(t.access().getAccessToken()).resolves.toBe('AT-refreshed')
    expect(auth.refresh).toHaveBeenCalledTimes(4)

    auth.refresh.mockRejectedValueOnce(new GmailAuthError('denied'))
    await expect(t.access().onUnauthorized()).resolves.toBe(false)
  })
})

describe('gmail integration: failures', () => {
  it('network, server and rate-limited go offline keeping unread, waiting 1/2/4/5/5 min; success restores the rhythm', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    expect(t.gmail.state().unread).toBe(3)

    const codes = ['network', 'server', 'rate-limited', 'network', 'server'] as const
    let failure = 0
    t.api.unreadIds.mockImplementation(async () => {
      throw new GmailApiError(codes[failure++ % codes.length]!)
    })
    await vi.advanceTimersByTimeAsync(MIN) // first failure
    expect(t.gmail.state()).toMatchObject({ status: 'offline', unread: 3, account: 'me@example.com', updatedAt: '2026-11-11T10:00:00.000Z' })

    for (const wait of [1, 2, 4, 5]) {
      const before = t.api.unreadIds.mock.calls.length
      await vi.advanceTimersByTimeAsync(wait * MIN - 1)
      expect(t.api.unreadIds).toHaveBeenCalledTimes(before)
      await vi.advanceTimersByTimeAsync(1)
      expect(t.api.unreadIds).toHaveBeenCalledTimes(before + 1)
      expect(t.gmail.state()).toMatchObject({ status: 'offline', unread: 3 })
    }
    // Capped at 5 min.
    let before = t.api.unreadIds.mock.calls.length
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(t.api.unreadIds).toHaveBeenCalledTimes(before + 1)

    t.api.unreadIds.mockResolvedValue(ids(7))
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(t.gmail.state()).toMatchObject({ status: 'ok', unread: 7 })
    before = t.api.unreadIds.mock.calls.length
    await vi.advanceTimersByTimeAsync(MIN)
    expect(t.api.unreadIds).toHaveBeenCalledTimes(before + 1)
  })

  it('unauthorized → expired, and no more requests until signing in again', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    t.gmail.setViewOpen(true)
    await flush()
    t.api.unreadIds.mockRejectedValue(new GmailApiError('unauthorized'))
    await vi.advanceTimersByTimeAsync(MIN)
    expect(t.gmail.state().status).toBe('expired')
    await expect(t.gmail.recent()).resolves.toEqual([])

    const before = t.requests()
    const refreshes = t.auths[0]!.refresh.mock.calls.length
    t.gmail.refresh()
    t.gmail.start()
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(t.requests()).toBe(before)
    expect(t.auths[0]!.refresh).toHaveBeenCalledTimes(refreshes)

    t.api.unreadIds.mockResolvedValue(ids(1))
    const result = t.gmail.signIn()
    await flush()
    t.finishSignIn()
    await expect(result).resolves.toBe('ok')
    await flush()
    expect(t.gmail.state()).toMatchObject({ status: 'ok', unread: 1 })
  })

  it('a refused token refresh (denied) → expired', async () => {
    const t = setup({ prepareAuth: (a) => a.refresh.mockRejectedValue(new GmailAuthError('denied')) })
    await t.gmail.ready
    await flush()
    expect(t.gmail.state().status).toBe('expired')
    expect(t.requests()).toBe(0)
  })
})

describe('gmail integration: sign-in and sign-out', () => {
  it('signIn → signing-in → ok, saves the token and queries with the new access token', async () => {
    const t = setup({ token: null })
    await t.gmail.ready
    const result = t.gmail.signIn()
    await flush()
    expect(t.gmail.state().status).toBe('signing-in')
    expect(t.states.at(-1)?.status).toBe('signing-in')
    t.finishSignIn()
    await expect(result).resolves.toBe('ok')
    await flush()
    expect(t.tokenStore.save).toHaveBeenCalledWith('RT-new')
    expect(t.gmail.state()).toMatchObject({ status: 'ok', account: 'me@example.com', unread: 3 })
    expect(t.tokensUsed).toContain('AT-new')
    expect(t.auths[0]!.refresh).not.toHaveBeenCalled()
  })

  it('a cancelled sign-in goes back to signed-out; timeout and denied are errors', async () => {
    const t = setup({ token: null })
    await t.gmail.ready
    let result = t.gmail.signIn()
    await flush()
    t.gmail.cancelSignIn()
    await expect(result).resolves.toBe('cancelled')
    expect(t.gmail.state().status).toBe('signed-out')

    for (const code of ['timeout', 'denied', 'network'] as const) {
      result = t.gmail.signIn()
      await flush()
      t.failSignIn(code)
      await expect(result).resolves.toBe('error')
      expect(t.gmail.state().status).toBe('signed-out')
    }
    expect(t.tokenStore.save).not.toHaveBeenCalled()
  })

  it('two sign-ins keep only one alive: the first resolves cancelled, the second wins', async () => {
    const t = setup({ token: null })
    await t.gmail.ready
    const first = t.gmail.signIn()
    await flush()
    const second = t.gmail.signIn()
    await flush()
    await expect(first).resolves.toBe('cancelled')
    expect(t.gmail.state().status).toBe('signing-in')
    t.finishSignIn()
    await expect(second).resolves.toBe('ok')
    expect(t.gmail.state().status).toBe('ok')
    expect(t.auths).toHaveLength(1)
    expect(t.auths[0]!.signIn).toHaveBeenCalledTimes(2)
  })

  it('without a client, signIn is an error and opens nothing', async () => {
    const t = setup({ clientId: '' })
    await t.gmail.ready
    await expect(t.gmail.signIn()).resolves.toBe('error')
    expect(t.authFactory).not.toHaveBeenCalled()
  })

  it('signOut revokes and clears the token; a failed revoke does not stop the clear', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    t.auths[0]!.revoke.mockRejectedValue(new Error('offline'))
    await t.gmail.signOut()
    expect(t.auths[0]!.revoke).toHaveBeenCalledWith('RT-stored')
    expect(t.tokenStore.clear).toHaveBeenCalled()
    expect(t.stored()).toBeNull()
    expect(t.gmail.state()).toEqual({ status: 'signed-out', account: null, unread: null, updatedAt: null, persistent: true, reason: null })

    const before = t.requests()
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(t.requests()).toBe(before)
  })

  it('a poll in flight when signing out never brings old data back', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    let release: (next: string[]) => void = () => undefined
    t.api.unreadIds.mockImplementationOnce(() => new Promise<string[]>((resolve) => (release = resolve)))
    await vi.advanceTimersByTimeAsync(MIN)
    await t.gmail.signOut()
    release(ids(9))
    await flush()
    expect(t.gmail.state()).toMatchObject({ status: 'signed-out', unread: null })
  })
})

describe('gmail integration: settings', () => {
  it('changing the client id while signed in clears the token and signs out, with no request on the old client', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    const oldAuth = t.auths[0]!
    const before = t.requests()

    t.changeSettings({ clientId: 'cid-2', clientSecret: 'csecret' })
    await flush()
    expect(t.tokenStore.clear).toHaveBeenCalled()
    expect(t.stored()).toBeNull()
    expect(t.gmail.state()).toMatchObject({ status: 'signed-out', account: null, unread: null })
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(t.requests()).toBe(before)
    expect(oldAuth.refresh).toHaveBeenCalledTimes(1)
    expect(oldAuth.revoke).not.toHaveBeenCalled()

    // Signing in again uses the new client.
    const result = t.gmail.signIn()
    await flush()
    expect(t.authFactory).toHaveBeenLastCalledWith({ clientId: 'cid-2', clientSecret: 'csecret' })
    t.finishSignIn()
    await expect(result).resolves.toBe('ok')
  })

  it('changing the secret also signs out; emptying the client id → unconfigured', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    t.changeSettings({ clientId: 'cid', clientSecret: 'other' })
    await flush()
    expect(t.gmail.state().status).toBe('signed-out')
    t.changeSettings({ clientId: '', clientSecret: '' })
    await flush()
    expect(t.gmail.state().status).toBe('unconfigured')
    t.changeSettings({ clientId: 'cid', clientSecret: 'x' })
    await flush()
    expect(t.gmail.state().status).toBe('signed-out')
  })

  it('ignores unrelated settings changes', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    t.changeSettings({ clientId: 'cid', clientSecret: 'csecret' })
    await flush()
    expect(t.gmail.state().status).toBe('ok')
    expect(t.tokenStore.clear).not.toHaveBeenCalled()
  })

  it('a sign-in in progress is cancelled when the client changes', async () => {
    const t = setup({ token: null })
    await t.gmail.ready
    const result = t.gmail.signIn()
    await flush()
    t.changeSettings({ clientId: 'cid-2', clientSecret: 'csecret' })
    await expect(result).resolves.toBe('cancelled')
    expect(t.gmail.state().status).toBe('signed-out')
    expect(t.tokenStore.save).not.toHaveBeenCalled()
  })
})

describe('gmail integration: open', () => {
  it('opens only ids of the last list sent, by thread; without id opens the inbox', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    t.gmail.setViewOpen(true)
    await flush()
    await t.gmail.recent()

    t.gmail.open('unknown')
    await flush()
    expect(t.openExternal).not.toHaveBeenCalled()

    t.gmail.open('m2')
    await flush()
    expect(t.openExternal).toHaveBeenLastCalledWith('https://mail.google.com/mail/u/0/#inbox/thread-m2')

    t.gmail.open()
    await flush()
    expect(t.openExternal).toHaveBeenLastCalledWith('https://mail.google.com/mail/u/0/#inbox')
  })

  it('refuses ids that were fetched but never sent to the notch', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    t.gmail.setViewOpen(true)
    await flush()
    t.gmail.open('m1')
    await flush()
    expect(t.openExternal).not.toHaveBeenCalled()
  })
})

describe('gmail integration: open from the reader', () => {
  const alertOnly = async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    // A new mail that is only known from the alert (never in a sent list).
    t.api.unreadIds.mockResolvedValue(['n1', ...ids(3)])
    await vi.advanceTimersByTimeAsync(MIN)
    expect(t.newMail.map((m) => m.id)).toEqual(['n1'])
    return t
  }

  it('opens the thread of the open message even when it is not in the last list', async () => {
    const t = await alertOnly()
    await t.gmail.message('n1')
    t.gmail.open('n1')
    await flush()
    expect(t.openExternal).toHaveBeenLastCalledWith('https://mail.google.com/mail/u/0/#inbox/thread-n1')
  })

  it('opens the inbox for a shown id whose thread is unknown (alert only, or the read never finished)', async () => {
    const t = await alertOnly()
    t.gmail.open('n1')
    await flush()
    expect(t.openExternal).toHaveBeenLastCalledWith('https://mail.google.com/mail/u/0/#inbox')

    t.api.message.mockRejectedValueOnce(new GmailApiError('network'))
    await expect(refusal(t.gmail.message('n1'))).resolves.toBe('UNAVAILABLE')
    t.gmail.open('n1')
    await flush()
    expect(t.openExternal).toHaveBeenLastCalledWith('https://mail.google.com/mail/u/0/#inbox')
    expect(t.openExternal).toHaveBeenCalledTimes(2)
  })

  it('still refuses ids never shown to the notch', async () => {
    const t = await alertOnly()
    t.gmail.open('m1')
    t.gmail.open('zzz')
    await flush()
    expect(t.openExternal).not.toHaveBeenCalled()
  })
})

describe('gmail integration: privacy and lifecycle', () => {
  it('never logs tokens, subjects, senders or snippets', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    t.gmail.setViewOpen(true)
    await flush()
    await t.gmail.recent()
    t.gmail.open('nope')
    t.api.unreadIds.mockRejectedValueOnce(new GmailApiError('network'))
    await vi.advanceTimersByTimeAsync(MIN)
    t.api.unreadIds.mockRejectedValueOnce(new GmailApiError('unauthorized'))
    await vi.advanceTimersByTimeAsync(MIN)
    const signIn = t.gmail.signIn()
    await flush()
    t.finishSignIn()
    await signIn
    await t.gmail.signOut()

    const log = JSON.stringify(t.logger.entries)
    for (const secret of ['RT-stored', 'RT-new', 'AT-refreshed', 'AT-new', 'csecret', 'Subject m1', 'Sender m1', 'Snippet m1', 'me@example.com']) {
      expect(log).not.toContain(secret)
    }
    expect(t.logger.entries.length).toBeGreaterThan(0)
  })

  it('dispose stops the rhythm and ignores later settings changes', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    t.gmail.dispose()
    const before = t.requests()
    t.changeSettings({ clientId: 'other', clientSecret: 'x' })
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(t.requests()).toBe(before)
    expect(t.tokenStore.clear).not.toHaveBeenCalled()
  })
})

describe('gmail helpers', () => {
  it('accepts only an http://127.0.0.1:<port> origin as the dev base URL', () => {
    expect(parseGmailBaseOverride('http://127.0.0.1:4567')).toBe('http://127.0.0.1:4567')
    for (const bad of [
      undefined,
      '',
      'http://127.0.0.1',
      'http://127.0.0.1:0',
      'http://127.0.0.1:70000',
      'http://127.0.0.1:4567/',
      'http://127.0.0.1:4567/gmail',
      'https://127.0.0.1:4567',
      'http://localhost:4567',
      'http://127.0.0.1.evil.test:4567',
      'http://user@127.0.0.1:4567',
    ]) {
      expect(parseGmailBaseOverride(bad)).toBeUndefined()
    }
  })
})

describe('gmail integration: fix round 1', () => {
  it('a poll in flight when sign-in starts never overwrites signing-in; cancel still works; no ticks meanwhile', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    let release: (next: string[]) => void = () => undefined
    t.api.unreadIds.mockImplementationOnce(() => new Promise<string[]>((resolve) => (release = resolve)))
    await vi.advanceTimersByTimeAsync(MIN) // poll now in flight
    const result = t.gmail.signIn()
    await flush()
    release(ids(9))
    await flush()
    expect(t.gmail.state().status).toBe('signing-in')
    const before = t.requests()
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(t.requests()).toBe(before)
    expect(t.gmail.state().status).toBe('signing-in')

    t.gmail.cancelSignIn()
    await expect(result).resolves.toBe('cancelled')
    expect(t.auths[0]!.cancel).toHaveBeenCalled()
    // The previous session comes back and polls again.
    await flush()
    expect(t.gmail.state().status).toBe('ok')
  })

  it('cancelSignIn does nothing without a pending sign-in', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    t.gmail.cancelSignIn()
    expect(t.auths[0]!.cancel).not.toHaveBeenCalled()
  })

  it('a sign-out right after a sign-in waits for the token save before clearing it', async () => {
    const t = setup({ token: null })
    await t.gmail.ready
    let finishSave: () => void = () => undefined
    let savedToken: string | null = null
    const order: string[] = []
    t.tokenStore.save.mockImplementationOnce(
      (token: string) =>
        new Promise<void>((resolve) => {
          finishSave = () => {
            savedToken = token
            order.push('save')
            resolve()
          }
        }),
    )
    t.tokenStore.clear.mockImplementation(async () => {
      savedToken = null
      order.push('clear')
    })
    const result = t.gmail.signIn()
    await flush()
    t.finishSignIn()
    await flush()
    const signOut = t.gmail.signOut()
    await flush()
    expect(order).toEqual([])
    finishSave()
    await signOut
    await result
    expect(order).toEqual(['save', 'clear'])
    expect(savedToken).toBeNull()
  })

  it('onUnauthorized from an older session changes nothing in the new one', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    const oldAccess = t.access()
    await t.gmail.signOut()
    const result = t.gmail.signIn()
    await flush()
    t.finishSignIn()
    await result
    await flush()
    const refreshes = t.auths[0]!.refresh.mock.calls.length
    await expect(oldAccess.onUnauthorized()).resolves.toBe(false)
    await expect(oldAccess.getAccessToken()).rejects.toBeInstanceOf(GmailApiError)
    expect(t.auths[0]!.refresh).toHaveBeenCalledTimes(refreshes)
    await expect(t.access().getAccessToken()).resolves.toBe('AT-new')
  })

  it('a failed recent list keeps the new count and the last list', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    t.gmail.setViewOpen(true)
    await flush()
    await expect(t.gmail.recent()).resolves.toHaveLength(2)
    t.api.unreadIds.mockResolvedValue(ids(5))
    t.api.recent.mockRejectedValueOnce(new GmailApiError('network'))
    await vi.advanceTimersByTimeAsync(MIN)
    expect(t.gmail.state()).toMatchObject({ status: 'ok', unread: 5 })
    await expect(t.gmail.recent()).resolves.toHaveLength(2)
  })
})
describe('gmail integration: stalled OAuth requests', () => {
  /** Real auth whose /token and /revoke never answer; the timeout runs on the fake clock. */
  const stalledAuth = () => {
    let answer: ((r: Response) => void) | null = null
    const fetchMock = vi.fn<GmailFetch>(
      (_url, init) =>
        new Promise<Response>((resolve, reject) => {
          answer = resolve
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
        }),
    )
    const real = createGmailAuth({
      fetch: fetchMock,
      openExternal: () => undefined,
      oauthBase: 'https://oauth.test',
      clientId: 'cid',
      clientSecret: 'csecret',
      timeoutSignal: (ms) => {
        const controller = new AbortController()
        setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), ms)
        return controller.signal
      },
    })
    return { real, fetchMock, answer: (r: Response) => answer?.(r) }
  }

  it('a hung token refresh times out as network → offline, then recovers', async () => {
    const stalled = stalledAuth()
    const t = setup({
      prepareAuth: (a) => {
        a.refresh.mockImplementation((token) => stalled.real.refresh(token))
      },
    })
    await t.gmail.ready
    await flush()
    expect(t.gmail.state().status).toBe('ok') // waiting on the refresh, nothing published yet
    expect(stalled.fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(t.gmail.state().status).toBe('offline')
    expect(t.tokenStore.clear).not.toHaveBeenCalled()

    t.auths[0]!.refresh.mockResolvedValue({ accessToken: 'AT-back', expiresAt: Date.now() + 3_600_000 })
    await vi.advanceTimersByTimeAsync(MIN)
    expect(t.gmail.state()).toMatchObject({ status: 'ok', unread: 3 })
  })

  it('sign-out with a hung revoke still clears the token and finishes', async () => {
    const stalled = stalledAuth()
    const t = setup({
      prepareAuth: (a) => {
        a.revoke.mockImplementation((token) => stalled.real.revoke(token))
      },
    })
    await t.gmail.ready
    await flush()
    let done = false
    const signingOut = t.gmail.signOut().then(() => {
      done = true
    })
    await flush()
    expect(t.stored()).toBeNull()
    expect(t.gmail.state().status).toBe('signed-out')
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(30_000)
    await signingOut
    expect(done).toBe(true)
  })
})

/** The list m1, m2 has been sent to the notch. */
const showList = async (t: ReturnType<typeof setup>) => {
  await t.gmail.ready
  await flush()
  t.gmail.setViewOpen(true)
  await flush()
  await t.gmail.recent()
}

const refusal = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(ExposedIpcError)
  return (error as ExposedIpcError).code
}

const syncRefusal = (fn: () => void) => {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(ExposedIpcError)
    return (error as ExposedIpcError).code
  }
  return null
}

describe('gmail integration: shown ids', () => {
  it('accepts ids of the last list sent; refuses others without any request', async () => {
    const t = setup()
    await showList(t)
    await expect(t.gmail.message('m1')).resolves.toEqual(detail('m1'))
    expect(t.api.message).toHaveBeenCalledWith('m1')

    for (const call of [() => t.gmail.message('zzz'), () => t.gmail.markRead('zzz'), () => t.gmail.remove('zzz')]) {
      await expect(refusal(call())).resolves.toBe('INVALID_INPUT')
    }
    expect(t.api.message).toHaveBeenCalledTimes(1)
    expect(t.api.markRead).not.toHaveBeenCalled()
    expect(t.api.remove).not.toHaveBeenCalled()
  })

  it('refuses ids fetched but never sent to the notch', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    t.gmail.setViewOpen(true)
    await flush()
    await expect(refusal(t.gmail.remove('m1'))).resolves.toBe('INVALID_INPUT')
    expect(t.api.remove).not.toHaveBeenCalled()
  })

  it('the open message and the last alert also count as shown', async () => {
    const t = setup()
    await showList(t)
    await t.gmail.message('m1')
    t.setList([message('m3')])
    await vi.advanceTimersByTimeAsync(MIN)
    await t.gmail.recent() // the notch now shows only m3
    await expect(t.gmail.markRead('m1')).resolves.toBeUndefined()
    expect(t.api.markRead).toHaveBeenCalledWith('m1')

    t.api.unreadIds.mockResolvedValue(['n1', ...ids(3)])
    await vi.advanceTimersByTimeAsync(MIN)
    expect(t.newMail.map((m) => m.id)).toEqual(['n1'])
    await expect(t.gmail.message('n1')).resolves.toMatchObject({ id: 'n1' })
  })

  it('maps failures to clean codes: gone → NOT_FOUND, others → UNAVAILABLE; a dead session expires', async () => {
    const t = setup()
    await showList(t)
    t.api.message.mockRejectedValueOnce(new GmailApiError('not-found'))
    await expect(refusal(t.gmail.message('m1'))).resolves.toBe('NOT_FOUND')
    t.api.message.mockRejectedValueOnce(new GmailApiError('invalid-response'))
    await expect(refusal(t.gmail.message('m1'))).resolves.toBe('UNAVAILABLE')
    t.api.markRead.mockRejectedValueOnce(new GmailApiError('network'))
    await expect(refusal(t.gmail.markRead('m1'))).resolves.toBe('UNAVAILABLE')
    expect(t.gmail.state().status).toBe('ok')
    t.api.remove.mockRejectedValueOnce(new GmailApiError('unauthorized'))
    await expect(refusal(t.gmail.remove('m2'))).resolves.toBe('UNAVAILABLE')
    expect(t.gmail.state().status).toBe('expired')
  })

  it('without a session every action is refused', async () => {
    const t = setup({ token: null })
    await t.gmail.ready
    await expect(refusal(t.gmail.message('m1'))).resolves.toBe('INVALID_INPUT')
    expect(t.requests()).toBe(0)
  })
})

describe('gmail integration: links', () => {
  it('opens only a link of the open message, by index', async () => {
    const t = setup()
    await showList(t)
    await t.gmail.message('m1')
    t.gmail.openLink('m1', 1)
    await flush()
    expect(t.openExternal).toHaveBeenLastCalledWith('https://example.com/m1/2')

    expect(syncRefusal(() => t.gmail.openLink('m1', 2))).toBe('INVALID_INPUT')
    expect(syncRefusal(() => t.gmail.openLink('m2', 0))).toBe('INVALID_INPUT')
    expect(t.openExternal).toHaveBeenCalledTimes(1)
  })

  it('refuses a link that is not http/https even if it slipped into the message', async () => {
    const t = setup()
    await showList(t)
    t.api.message.mockResolvedValueOnce(detail('m1', { links: [{ text: 'x', url: 'javascript:alert(1)' }] }))
    await t.gmail.message('m1')
    expect(syncRefusal(() => t.gmail.openLink('m1', 0))).toBe('INVALID_INPUT')
    expect(t.openExternal).not.toHaveBeenCalled()
  })

  it('forgets the open message when the reading closes, another one opens, or on sign-out', async () => {
    const t = setup()
    await showList(t)
    await t.gmail.message('m1')
    t.gmail.setViewOpen(false)
    expect(syncRefusal(() => t.gmail.openLink('m1', 0))).toBe('INVALID_INPUT')

    t.gmail.setViewOpen(true)
    await t.gmail.message('m1')
    await t.gmail.message('m2')
    expect(syncRefusal(() => t.gmail.openLink('m1', 0))).toBe('INVALID_INPUT')
    t.gmail.openLink('m2', 0)
    await flush()
    expect(t.openExternal).toHaveBeenLastCalledWith('https://example.com/m2/1')

    await t.gmail.signOut()
    expect(syncRefusal(() => t.gmail.openLink('m2', 0))).toBe('INVALID_INPUT')
  })

  it('a read that finishes after the reading closed is not remembered', async () => {
    const t = setup()
    await showList(t)
    let finish: (d: GmailMessageDetail) => void = () => undefined
    t.api.message.mockImplementationOnce(() => new Promise<GmailMessageDetail>((resolve) => (finish = resolve)))
    const reading = t.gmail.message('m1')
    await flush()
    t.gmail.setViewOpen(false)
    finish(detail('m1'))
    await reading
    expect(syncRefusal(() => t.gmail.openLink('m1', 0))).toBe('INVALID_INPUT')
  })
})

describe('gmail integration: closing the reader', () => {
  it('forgets the open message and its links, while the list ids stay shown', async () => {
    const t = setup()
    await showList(t)
    await t.gmail.message('m1')
    t.gmail.closeMessage()
    expect(syncRefusal(() => t.gmail.openLink('m1', 0))).toBe('INVALID_INPUT')
    expect(t.openExternal).not.toHaveBeenCalled()
    // Still in the last list: the row actions keep working.
    await t.gmail.markRead('m1')
    expect(t.api.markRead).toHaveBeenCalledWith('m1')
  })

  it('a read that finishes after the reader closed is not remembered', async () => {
    const t = setup()
    await showList(t)
    let finish: (d: GmailMessageDetail) => void = () => undefined
    t.api.message.mockImplementationOnce(() => new Promise<GmailMessageDetail>((resolve) => (finish = resolve)))
    const reading = t.gmail.message('m1')
    await flush()
    t.gmail.closeMessage()
    finish(detail('m1'))
    await reading
    expect(syncRefusal(() => t.gmail.openLink('m1', 0))).toBe('INVALID_INPUT')
  })
})

describe('gmail integration: actions', () => {
  it('markRead and remove query at once, past the 5 s manual floor', async () => {
    const t = setup()
    await showList(t)
    t.gmail.refresh()
    await flush()
    const before = t.api.unreadIds.mock.calls.length
    await t.gmail.markRead('m1')
    await flush()
    expect(t.api.unreadIds).toHaveBeenCalledTimes(before + 1)
    await t.gmail.remove('m2')
    await flush()
    expect(t.api.unreadIds).toHaveBeenCalledTimes(before + 2)
    expect(t.api.recent.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('a deleted message can no longer be named', async () => {
    const t = setup()
    await showList(t)
    await t.gmail.message('m1')
    await t.gmail.remove('m1')
    expect(t.api.remove).toHaveBeenCalledWith('m1')
    expect(syncRefusal(() => t.gmail.openLink('m1', 0))).toBe('INVALID_INPUT')
    await expect(refusal(t.gmail.remove('m1'))).resolves.toBe('INVALID_INPUT')
    expect(t.api.remove).toHaveBeenCalledTimes(1)
  })

  it('a message marked as read stays shown (the reader can still delete it)', async () => {
    const t = setup()
    await showList(t)
    await t.gmail.message('m1')
    await t.gmail.markRead('m1')
    await expect(t.gmail.remove('m1')).resolves.toBeUndefined()
  })
})

describe('gmail integration: new mail', () => {
  it('the first query only sets the baseline; new ids announce the newest with sender and subject', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    expect(t.newMail).toEqual([])

    t.api.unreadIds.mockResolvedValue(['n1', ...ids(3)])
    await vi.advanceTimersByTimeAsync(MIN)
    expect(t.api.summary).toHaveBeenCalledWith('n1')
    expect(t.newMail).toEqual([{ count: 1, id: 'n1', from: 'Sender n1', subject: 'Subject n1' }])

    t.api.unreadIds.mockResolvedValue(['n3', 'n2', 'n1', ...ids(3)])
    await vi.advanceTimersByTimeAsync(MIN)
    expect(t.newMail.at(-1)).toEqual({ count: 2, id: 'n3', from: 'Sender n3', subject: 'Subject n3' })

    // Same ids, or ids that went away: nothing new.
    t.api.unreadIds.mockResolvedValue(['n3'])
    await vi.advanceTimersByTimeAsync(MIN)
    expect(t.newMail).toHaveLength(2)
  })

  it('with hideContent the alert carries no sender or subject and asks no metadata', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    t.setAlerts({ hideContent: true })
    t.api.unreadIds.mockResolvedValue(['n1', ...ids(3)])
    await vi.advanceTimersByTimeAsync(MIN)
    expect(t.newMail).toEqual([{ count: 1, id: 'n1' }])
    expect(t.api.summary).not.toHaveBeenCalled()
  })

  it('with alerts off nothing is announced', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    t.setAlerts({ enabled: false })
    t.api.unreadIds.mockResolvedValue(['n1', ...ids(3)])
    await vi.advanceTimersByTimeAsync(MIN)
    expect(t.newMail).toEqual([])
    expect(t.api.summary).not.toHaveBeenCalled()
  })

  it('a failed metadata request still alerts, without content; a message already gone does not', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    t.api.summary.mockRejectedValueOnce(new GmailApiError('network'))
    t.api.unreadIds.mockResolvedValue(['n1', ...ids(3)])
    await vi.advanceTimersByTimeAsync(MIN)
    expect(t.newMail).toEqual([{ count: 1, id: 'n1' }])

    t.api.summary.mockResolvedValueOnce(null)
    t.api.unreadIds.mockResolvedValue(['n2', 'n1', ...ids(3)])
    await vi.advanceTimersByTimeAsync(MIN)
    expect(t.newMail).toHaveLength(1)
  })

  it('keeps the baseline over long stretches: mail arriving after an hour still alerts', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    await vi.advanceTimersByTimeAsync(60 * MIN)
    t.api.unreadIds.mockResolvedValue(['n1', ...ids(3)])
    await vi.advanceTimersByTimeAsync(MIN)
    expect(t.newMail.map((m) => m.id)).toEqual(['n1'])
  })

  describe('whatever the notch shows (the user-reported bug: mini paused polling and reset the baseline)', () => {
    /** Main's wiring: a new mail dispatches the alert to the notch; the notch mode never reaches Gmail. */
    const wired = () => {
      const surface: NotchSurface = {
        setBounds: () => {},
        show: vi.fn(),
        hide: () => {},
        focus: () => {},
        blur: () => {},
        setIgnoreMouse: () => {},
        sendMode: () => {},
        sendMailAlert: () => {},
        sendReviewAlert: () => {},
      }
      const notch = createNotchController({ surface, workArea: { x: 0, y: 0, width: 1920, height: 1032 }, logger: createMemoryLogger() })
      notch.start()
      const t = setup({ onNewMail: () => notch.dispatch({ type: 'mail', on: true }) })
      return { t, notch, surface }
    }

    const notchStates: [string, NotchEvent][] = [
      ['mini (pinned by the user)', { type: 'pin-mini' }],
      ['hidden (yielding to fullscreen)', { type: 'foreground', verdict: 'hidden' }],
      ['hidden by the user', { type: 'user-visibility', hidden: true }],
    ]
    for (const [label, event] of notchStates) {
      it(`alerts new mail while the capsule is ${label}`, async () => {
        const { t, notch } = wired()
        await t.gmail.ready
        await flush()
        notch.dispatch(event)
        const before = notch.mode()
        t.api.unreadIds.mockResolvedValue(['n1', ...ids(3)])
        await vi.advanceTimersByTimeAsync(MIN)
        expect(t.newMail.map((m) => m.id)).toEqual(['n1'])
        expect(notch.mode()).toBe('alert')
        await vi.advanceTimersByTimeAsync(6_000)
        expect(notch.mode()).toBe(before)
      })
    }

    it('alerts mail that arrived during a long hidden stretch (no new baseline)', async () => {
      const { t, notch } = wired()
      await t.gmail.ready
      await flush()
      notch.dispatch({ type: 'user-visibility', hidden: true })
      await vi.advanceTimersByTimeAsync(30 * MIN)
      t.api.unreadIds.mockResolvedValue(['n1', ...ids(3)])
      await vi.advanceTimersByTimeAsync(MIN)
      expect(t.newMail.map((m) => m.id)).toEqual(['n1'])
      // And mail arriving while that alert shows still counts as new afterwards.
      t.api.unreadIds.mockResolvedValue(['n2', 'n1', ...ids(3)])
      await vi.advanceTimersByTimeAsync(MIN)
      expect(t.newMail.map((m) => m.id)).toEqual(['n1', 'n2'])
    })
  })

  it('a new client starts a new baseline', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    t.api.unreadIds.mockResolvedValue(['n1', ...ids(3)])
    t.changeSettings({ clientId: 'other', clientSecret: 'x' })
    await flush()
    const result = t.gmail.signIn()
    await flush()
    t.finishSignIn()
    await result
    await flush()
    expect(t.newMail).toEqual([])
    t.api.unreadIds.mockResolvedValue(['n2', 'n1', ...ids(3)])
    await vi.advanceTimersByTimeAsync(MIN)
    expect(t.newMail.map((m) => m.id)).toEqual(['n2'])
  })

  it('signing out and in again starts a new baseline; then new mail alerts again', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    await t.gmail.signOut()
    t.api.unreadIds.mockResolvedValue(['n1', ...ids(3)])
    const result = t.gmail.signIn()
    await flush()
    t.finishSignIn()
    await result
    await flush()
    expect(t.newMail).toEqual([])
    t.api.unreadIds.mockResolvedValue(['n2', 'n1', ...ids(3)])
    await vi.advanceTimersByTimeAsync(MIN)
    expect(t.newMail.map((m) => m.id)).toEqual(['n2'])
  })

  it('a new session starts a new baseline', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    await t.gmail.signOut()
    t.api.unreadIds.mockResolvedValue(['n1', ...ids(3)])
    const result = t.gmail.signIn()
    await flush()
    t.finishSignIn()
    await result
    await flush()
    expect(t.newMail).toEqual([])
  })
})

describe('gmail integration: permission (scope)', () => {
  const READONLY = 'https://www.googleapis.com/auth/gmail.readonly'

  it('a refresh without the full mail scope → expired with reason scope, and no more requests', async () => {
    const t = setup({ prepareAuth: (a) => a.refresh.mockResolvedValue({ accessToken: 'AT-old', expiresAt: Date.now() + 3_600_000, scope: READONLY }) })
    await t.gmail.ready
    await flush()
    expect(t.gmail.state()).toMatchObject({ status: 'expired', reason: 'scope' })
    expect(t.states.at(-1)).toMatchObject({ status: 'expired', reason: 'scope' })
    expect(t.requests()).toBe(0)
    const refreshes = t.auths[0]!.refresh.mock.calls.length
    t.gmail.refresh()
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(t.requests()).toBe(0)
    expect(t.auths[0]!.refresh).toHaveBeenCalledTimes(refreshes)
    expect(t.tokenStore.clear).not.toHaveBeenCalled()

    // Signing in again with the full scope clears the reason.
    const result = t.gmail.signIn()
    await flush()
    t.finishSignIn({ scope: 'https://mail.google.com/' })
    await expect(result).resolves.toBe('ok')
    await flush()
    expect(t.gmail.state()).toMatchObject({ status: 'ok', reason: null })
  })

  it('a refresh with the full scope (among others) is fine', async () => {
    const t = setup({
      prepareAuth: (a) => a.refresh.mockResolvedValue({ accessToken: 'AT', expiresAt: Date.now() + 3_600_000, scope: `openid https://mail.google.com/` }),
    })
    await t.gmail.ready
    await flush()
    expect(t.gmail.state()).toMatchObject({ status: 'ok', reason: null })
  })

  it('a sign-in that did not grant the full scope is not kept', async () => {
    const t = setup({ token: null })
    await t.gmail.ready
    const result = t.gmail.signIn()
    await flush()
    t.finishSignIn({ scope: READONLY })
    await expect(result).resolves.toBe('error')
    expect(t.gmail.state()).toMatchObject({ status: 'expired', reason: 'scope' })
    expect(t.tokenStore.save).not.toHaveBeenCalled()
    expect(t.requests()).toBe(0)
  })
})

describe('gmail integration: privacy of mail data', () => {
  it('never logs bodies, links, subjects or senders', async () => {
    const t = setup()
    await showList(t)
    await t.gmail.message('m1')
    t.gmail.openLink('m1', 0)
    expect(syncRefusal(() => t.gmail.openLink('m1', 9))).toBe('INVALID_INPUT')
    await t.gmail.markRead('m1')
    t.api.remove.mockRejectedValueOnce(new GmailApiError('server'))
    await refusal(t.gmail.remove('m2'))
    t.api.unreadIds.mockResolvedValue(['n1', ...ids(3)])
    await vi.advanceTimersByTimeAsync(MIN)
    expect(t.newMail).toHaveLength(1)
    const log = JSON.stringify(t.logger.entries)
    for (const secret of ['Body m1', 'example.com/m1', 'Subject n1', 'Sender n1', 'Subject m1', 'Sender m1', 'm1@example.com']) {
      expect(log).not.toContain(secret)
    }
  })
})
