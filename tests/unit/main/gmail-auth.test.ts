import { afterEach, describe, expect, it, vi } from 'vitest'
import { GmailAuthError, createGmailAuth, createPkce, pkceChallenge, type GmailFetch } from '../../../src/main/gmail/gmail-auth'

describe('pkce', () => {
  it('matches the RFC 7636 appendix B vector', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('creates a base64url verifier of valid length, its challenge and a distinct state', () => {
    const { verifier, challenge, state } = createPkce()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
    expect(challenge).toBe(pkceChallenge(verifier))
    expect(state).toMatch(/^[A-Za-z0-9_-]{16,}$/)
    expect(state).not.toBe(verifier)
  })

  it('uses the injected randomness', () => {
    const a = createPkce((n) => Buffer.alloc(n, 1))
    const b = createPkce((n) => Buffer.alloc(n, 1))
    expect(a).toEqual(b)
  })
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const tokens = { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, token_type: 'Bearer' }

const setup = (reply: () => Response | Promise<Response> = () => json(tokens)) => {
  const urls: string[] = []
  const fetchMock = vi.fn<GmailFetch>(async () => reply())
  const openExternal = vi.fn(async (url: string) => {
    urls.push(url)
  })
  const auth = createGmailAuth({
    fetch: fetchMock,
    openExternal,
    oauthBase: 'https://oauth.test',
    clientId: 'cid',
    clientSecret: 'csecret',
    now: () => 1_000_000,
  })
  return { auth, fetchMock, openExternal, urls }
}
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(check()).toBe(true)
}
const form = (init: RequestInit | undefined) => new URLSearchParams(String(init?.body))

const pending: { cancel(): void }[] = []
afterEach(() => {
  for (const a of pending.splice(0)) a.cancel()
})

describe('signIn', () => {
  it('opens the consent url with every parameter and exchanges the code with the verifier', async () => {
    const { auth, fetchMock, urls } = setup()
    pending.push(auth)
    const result = auth.signIn()
    await until(() => urls.length === 1)
    const url = new URL(urls[0]!)
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    const q = url.searchParams
    expect(q.get('client_id')).toBe('cid')
    expect(q.get('response_type')).toBe('code')
    expect(q.get('scope')).toBe('https://www.googleapis.com/auth/gmail.readonly')
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('access_type')).toBe('offline')
    expect(q.get('prompt')).toBe('consent')
    const redirect = q.get('redirect_uri')!
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    const state = q.get('state')!
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)

    await fetch(`${redirect}?code=auth-code&state=${state}`)
    await expect(result).resolves.toEqual({ refreshToken: 'RT', accessToken: 'AT', expiresAt: 1_000_000 + 3_600_000 })

    const [tokenUrl, init] = fetchMock.mock.calls[0]!
    expect(tokenUrl).toBe('https://oauth.test/token')
    expect(init?.method).toBe('POST')
    const body = form(init)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('auth-code')
    expect(body.get('client_id')).toBe('cid')
    expect(body.get('client_secret')).toBe('csecret')
    expect(body.get('redirect_uri')).toBe(redirect)
    expect(pkceChallenge(body.get('code_verifier')!)).toBe(q.get('code_challenge'))
  })

  it('rejects the first sign-in with cancelled when a second one starts', async () => {
    const { auth, urls } = setup()
    pending.push(auth)
    const first = auth.signIn()
    const firstAssertion = expect(first).rejects.toMatchObject({ code: 'cancelled' })
    await until(() => urls.length === 1)
    const second = auth.signIn()
    const secondAssertion = expect(second).rejects.toMatchObject({ code: 'cancelled' })
    await firstAssertion
    await until(() => urls.length === 2)
    auth.cancel()
    await secondAssertion
  })

  it('cancel() closes the loopback server and rejects with cancelled', async () => {
    const { auth, urls } = setup()
    const result = auth.signIn()
    const assertion = expect(result).rejects.toMatchObject({ code: 'cancelled' })
    await until(() => urls.length === 1)
    const redirect = new URL(urls[0]!).searchParams.get('redirect_uri')!
    auth.cancel()
    await assertion
    await expect(fetch(`${redirect}?code=x&state=y`)).rejects.toThrow()
  })

  it('rejects with denied when the user refuses consent', async () => {
    const { auth, urls } = setup()
    const result = auth.signIn()
    const assertion = expect(result).rejects.toMatchObject({ code: 'denied' })
    await until(() => urls.length === 1)
    const q = new URL(urls[0]!).searchParams
    await fetch(`${q.get('redirect_uri')}?error=access_denied&state=${q.get('state')}`)
    await assertion
  })

  it('rejects with invalid-response on a malformed or refresh-less token response', async () => {
    for (const body of [{ nope: 1 }, { access_token: 'AT', expires_in: 1, token_type: 'Bearer' }]) {
      const { auth, urls } = setup(() => json(body))
      const result = auth.signIn()
      const assertion = expect(result).rejects.toMatchObject({ code: 'invalid-response' })
      await until(() => urls.length === 1)
      const q = new URL(urls[0]!).searchParams
      await fetch(`${q.get('redirect_uri')}?code=c&state=${q.get('state')}`)
      await assertion
    }
  })

  it('rejects with network when the token request fails', async () => {
    const { auth, urls } = setup(() => {
      throw new TypeError('offline')
    })
    const result = auth.signIn()
    const assertion = expect(result).rejects.toMatchObject({ code: 'network' })
    await until(() => urls.length === 1)
    const q = new URL(urls[0]!).searchParams
    await fetch(`${q.get('redirect_uri')}?code=c&state=${q.get('state')}`)
    await assertion
  })

  it('rejects with network when the browser cannot be opened', async () => {
    const auth = createGmailAuth({
      fetch: vi.fn(),
      openExternal: async () => {
        throw new Error('no browser')
      },
      oauthBase: 'https://oauth.test',
      clientId: 'cid',
      clientSecret: 'csecret',
    })
    await expect(auth.signIn()).rejects.toMatchObject({ code: 'network' })
  })
})

describe('cancelling during the token exchange', () => {
  const slowSetup = () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let aborted = false
    const s = setup(async () => {
      await gate
      return json(tokens)
    })
    const original = s.fetchMock.getMockImplementation()!
    s.fetchMock.mockImplementation(async (url, init) => {
      init?.signal?.addEventListener('abort', () => (aborted = true))
      return original(url, init)
    })
    return { ...s, release, wasAborted: () => aborted }
  }
  const sendCode = async (url: string) => {
    const q = new URL(url).searchParams
    await fetch(`${q.get('redirect_uri')}?code=c&state=${q.get('state')}`)
  }

  it('cancel() during a slow /token rejects with cancelled and aborts the request', async () => {
    const { auth, urls, fetchMock, release, wasAborted } = slowSetup()
    pending.push(auth)
    const result = auth.signIn()
    const assertion = expect(result).rejects.toMatchObject({ code: 'cancelled' })
    await until(() => urls.length === 1)
    await sendCode(urls[0]!)
    await until(() => fetchMock.mock.calls.length === 1)
    auth.cancel()
    release()
    await assertion
    expect(wasAborted()).toBe(true)
  })

  it('a second signIn during the exchange makes the first reject with cancelled', async () => {
    const { auth, urls, fetchMock, release } = slowSetup()
    pending.push(auth)
    const first = auth.signIn()
    const firstAssertion = expect(first).rejects.toMatchObject({ code: 'cancelled' })
    await until(() => urls.length === 1)
    await sendCode(urls[0]!)
    await until(() => fetchMock.mock.calls.length === 1)
    const second = auth.signIn()
    const secondAssertion = expect(second).rejects.toMatchObject({ code: 'cancelled' })
    release()
    await firstAssertion
    auth.cancel()
    await secondAssertion
  })
})

describe('refresh and revoke', () => {
  it('refresh sends the refresh grant and returns the new access token', async () => {
    const { auth, fetchMock } = setup(() => json({ access_token: 'AT2', expires_in: 100, token_type: 'Bearer' }))
    await expect(auth.refresh('RT')).resolves.toEqual({ accessToken: 'AT2', expiresAt: 1_000_000 + 100_000 })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://oauth.test/token')
    expect(Object.fromEntries(form(init))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'RT',
      client_id: 'cid',
      client_secret: 'csecret',
    })
  })

  it('refresh maps errors: 400/401 denied, 5xx and throws network, bad body invalid-response', async () => {
    const code = async (reply: () => Response) => {
      const { auth } = setup(reply)
      return auth.refresh('RT').then(
        () => 'ok',
        (e: unknown) => (e as GmailAuthError).code,
      )
    }
    expect(await code(() => json({ error: 'invalid_grant' }, 400))).toBe('denied')
    expect(await code(() => json({}, 401))).toBe('denied')
    expect(await code(() => json({}, 503))).toBe('network')
    expect(await code(() => json({}, 429))).toBe('network')
    expect(await code(() => json({ nope: 1 }))).toBe('invalid-response')
    const { auth } = setup(() => {
      throw new TypeError('down')
    })
    await expect(auth.refresh('RT')).rejects.toMatchObject({ code: 'network' })
  })

  it('revoke posts the token and never throws on failure', async () => {
    const { auth, fetchMock } = setup(() => json({}))
    await auth.revoke('RT')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://oauth.test/revoke')
    expect(init?.method).toBe('POST')
    expect(Object.fromEntries(form(init))).toEqual({ token: 'RT' })

    const failing = setup(() => {
      throw new TypeError('down')
    })
    await expect(failing.auth.revoke('RT')).resolves.toBeUndefined()
  })
})

describe('request timeout', () => {
  /** A fetch that never answers; it only settles when its signal aborts. */
  const hungFetch = vi.fn<GmailFetch>(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) return
        if (signal.aborted) reject(signal.reason)
        signal.addEventListener('abort', () => reject(signal.reason))
      }),
  )
  const timeouts: number[] = []
  const hungAuth = (openExternal: (url: string) => void = () => undefined) =>
    createGmailAuth({
      fetch: hungFetch,
      openExternal,
      oauthBase: 'https://oauth.test',
      clientId: 'cid',
      clientSecret: 'csecret',
      timeoutSignal: (ms) => {
        timeouts.push(ms)
        return AbortSignal.timeout(20)
      },
    })

  it('a stalled refresh rejects with network after the timeout (30 s by default)', async () => {
    await expect(hungAuth().refresh('RT')).rejects.toMatchObject({ code: 'network' })
    expect(timeouts.at(-1)).toBe(30_000)
  })

  it('a stalled revoke resolves after the timeout', async () => {
    await expect(hungAuth().revoke('RT')).resolves.toBeUndefined()
  })

  it('a stalled code exchange rejects with network, not cancelled', async () => {
    const urls: string[] = []
    const auth = hungAuth((url) => {
      urls.push(url)
    })
    pending.push(auth)
    const result = auth.signIn()
    const assertion = expect(result).rejects.toMatchObject({ code: 'network' })
    await until(() => urls.length === 1)
    const q = new URL(urls[0]!).searchParams
    await fetch(`${q.get('redirect_uri')}?code=c&state=${q.get('state')}`)
    await assertion
  })

  it('uses AbortSignal.timeout(30 s) when no timeout factory is given', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    try {
      const { auth } = setup(() => json({ access_token: 'AT2', expires_in: 100, token_type: 'Bearer' }))
      await auth.refresh('RT')
      expect(spy).toHaveBeenCalledWith(30_000)
    } finally {
      spy.mockRestore()
    }
  })
})
