import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { GmailAuthError } from '../../../src/main/gmail/auth-error'
import { createGmailAuth, type GmailAuth, type GmailFetch, type SignInResult } from '../../../src/main/gmail/gmail-auth'
import { GmailApiError, type GmailClient } from '../../../src/main/gmail/gmail-client'
import {
  createGmailIntegration,
  isGmailVisibleMode,
  parseGmailBaseOverride,
  type GmailClientAccess,
} from '../../../src/main/gmail/gmail-integration'
import type { GmailMessage, GmailState } from '../../../src/shared/gmail/schema'
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

interface SetupOptions {
  clientId?: string
  token?: string | null
  persistent?: boolean
  visible?: boolean
  /** Adjusts each fake auth as it is created (e.g. a failing refresh). */
  prepareAuth?: (auth: FakeAuth) => void
}

function setup(options: SetupOptions = {}) {
  vi.useFakeTimers({ now: new Date('2026-11-11T10:00:00.000Z') })
  const logger = createMemoryLogger()

  let current = { gmail: { clientId: options.clientId ?? 'cid', clientSecret: 'csecret' } }
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
  const changeSettings = (gmail: { clientId: string; clientSecret: string }) => {
    current = { gmail }
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
    unreadCount: vi.fn(async () => 3),
    recent: vi.fn(async () => list),
  }
  const tokensUsed: string[] = []
  let access: GmailClientAccess | null = null
  const clientFactory = vi.fn((deps: GmailClientAccess): GmailClient => {
    access = deps
    const call =
      <T>(fn: () => Promise<T>) =>
      async () => {
        tokensUsed.push(await deps.getAccessToken())
        return fn()
      }
    return { profile: call(() => api.profile()), unreadCount: call(() => api.unreadCount()), recent: call(() => api.recent()) }
  })

  const states: GmailState[] = []
  const openExternal = vi.fn()
  const gmail = createGmailIntegration({
    settings,
    tokenStore,
    authFactory,
    clientFactory,
    timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
    now: () => Date.now(),
    emit: (state) => states.push(state),
    openExternal,
    logger,
  })
  if (options.visible ?? true) gmail.setVisible(true)

  const requests = () => api.profile.mock.calls.length + api.unreadCount.mock.calls.length + api.recent.mock.calls.length
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
    expect(t.gmail.state()).toEqual({ status: 'unconfigured', account: null, unread: null, updatedAt: null, persistent: true })
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

  it('does not query while not visible', async () => {
    const t = setup({ visible: false })
    await t.gmail.ready
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(t.requests()).toBe(0)
    expect(t.gmail.state().status).toBe('ok')
  })
})

describe('gmail integration: rhythm', () => {
  it('ticks every 60 s only while visible and queries at once on return', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    expect(t.api.unreadCount).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(MIN - 1)
    expect(t.api.unreadCount).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(t.api.unreadCount).toHaveBeenCalledTimes(2)

    t.gmail.setVisible(false)
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(t.api.unreadCount).toHaveBeenCalledTimes(2)

    t.gmail.setVisible(true)
    await flush()
    expect(t.api.unreadCount).toHaveBeenCalledTimes(3)
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
    expect(t.api.unreadCount).toHaveBeenCalledTimes(4)
  })

  it('a manual refresh queries at once, at most once per 5 s', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(t.api.unreadCount).toHaveBeenCalledTimes(1)
    t.gmail.refresh()
    await flush()
    t.gmail.refresh()
    await flush()
    expect(t.api.unreadCount).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5_000)
    t.gmail.refresh()
    await flush()
    expect(t.api.unreadCount).toHaveBeenCalledTimes(3)
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
    t.api.unreadCount.mockImplementation(async () => {
      throw new GmailApiError(codes[failure++ % codes.length]!)
    })
    await vi.advanceTimersByTimeAsync(MIN) // first failure
    expect(t.gmail.state()).toMatchObject({ status: 'offline', unread: 3, account: 'me@example.com', updatedAt: '2026-11-11T10:00:00.000Z' })

    for (const wait of [1, 2, 4, 5]) {
      const before = t.api.unreadCount.mock.calls.length
      await vi.advanceTimersByTimeAsync(wait * MIN - 1)
      expect(t.api.unreadCount).toHaveBeenCalledTimes(before)
      await vi.advanceTimersByTimeAsync(1)
      expect(t.api.unreadCount).toHaveBeenCalledTimes(before + 1)
      expect(t.gmail.state()).toMatchObject({ status: 'offline', unread: 3 })
    }
    // Capped at 5 min.
    let before = t.api.unreadCount.mock.calls.length
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(t.api.unreadCount).toHaveBeenCalledTimes(before + 1)

    t.api.unreadCount.mockResolvedValue(7)
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(t.gmail.state()).toMatchObject({ status: 'ok', unread: 7 })
    before = t.api.unreadCount.mock.calls.length
    await vi.advanceTimersByTimeAsync(MIN)
    expect(t.api.unreadCount).toHaveBeenCalledTimes(before + 1)
  })

  it('unauthorized → expired, and no more requests until signing in again', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    t.gmail.setViewOpen(true)
    await flush()
    t.api.unreadCount.mockRejectedValue(new GmailApiError('unauthorized'))
    await vi.advanceTimersByTimeAsync(MIN)
    expect(t.gmail.state().status).toBe('expired')
    await expect(t.gmail.recent()).resolves.toEqual([])

    const before = t.requests()
    const refreshes = t.auths[0]!.refresh.mock.calls.length
    t.gmail.refresh()
    t.gmail.setVisible(false)
    t.gmail.setVisible(true)
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(t.requests()).toBe(before)
    expect(t.auths[0]!.refresh).toHaveBeenCalledTimes(refreshes)

    t.api.unreadCount.mockResolvedValue(1)
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
    expect(t.gmail.state()).toEqual({ status: 'signed-out', account: null, unread: null, updatedAt: null, persistent: true })

    const before = t.requests()
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(t.requests()).toBe(before)
  })

  it('a poll in flight when signing out never brings old data back', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    let release: (n: number) => void = () => undefined
    t.api.unreadCount.mockImplementationOnce(() => new Promise<number>((resolve) => (release = resolve)))
    await vi.advanceTimersByTimeAsync(MIN)
    await t.gmail.signOut()
    release(9)
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

describe('gmail integration: privacy and lifecycle', () => {
  it('never logs tokens, subjects, senders or snippets', async () => {
    const t = setup()
    await t.gmail.ready
    await flush()
    t.gmail.setViewOpen(true)
    await flush()
    await t.gmail.recent()
    t.gmail.open('nope')
    t.api.unreadCount.mockRejectedValueOnce(new GmailApiError('network'))
    await vi.advanceTimersByTimeAsync(MIN)
    t.api.unreadCount.mockRejectedValueOnce(new GmailApiError('unauthorized'))
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
  it('counts the capsule as visible in compact, peek and the panels; mini, hidden and alert pause', () => {
    for (const mode of ['compact', 'peek', 'expanded', 'terminal', 'permission', 'reminders', 'system', 'notes'] as const) {
      expect(isGmailVisibleMode(mode)).toBe(true)
    }
    for (const mode of ['mini', 'hidden', 'alert'] as const) expect(isGmailVisibleMode(mode)).toBe(false)
  })

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
    let release: (n: number) => void = () => undefined
    t.api.unreadCount.mockImplementationOnce(() => new Promise<number>((resolve) => (release = resolve)))
    await vi.advanceTimersByTimeAsync(MIN) // poll now in flight
    const result = t.gmail.signIn()
    await flush()
    release(9)
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
    t.api.unreadCount.mockResolvedValue(5)
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
