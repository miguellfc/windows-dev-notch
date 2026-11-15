import { afterEach, describe, expect, it, vi } from 'vitest'
import { GmailAuthError } from '../../../src/main/gmail/auth-error'
import { startLoopback } from '../../../src/main/gmail/loopback'

const open: { close(): void }[] = []
const start = async (timeoutMs?: number) => {
  const handle = await startLoopback({ state: 'good-state', ...(timeoutMs === undefined ? {} : { timeoutMs }) })
  open.push(handle)
  return handle
}
afterEach(() => {
  vi.useRealTimers()
  for (const handle of open.splice(0)) handle.close()
})

const settled = (promise: Promise<unknown>) => {
  let state: 'pending' | 'resolved' | 'rejected' = 'pending'
  promise.then(
    () => (state = 'resolved'),
    () => (state = 'rejected'),
  )
  return () => state
}

describe('loopback server', () => {
  it('listens on 127.0.0.1 and builds the redirect uri', async () => {
    const { redirectUri } = await start()
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
  })

  it('answers 400 to a wrong state and keeps waiting', async () => {
    const { redirectUri, code } = await start()
    const state = settled(code)
    const res = await fetch(`${redirectUri}?code=abc&state=evil`)
    expect(res.status).toBe(400)
    await new Promise((r) => setTimeout(r, 20))
    expect(state()).toBe('pending')
    const ok = await fetch(`${redirectUri}?code=abc&state=good-state`)
    expect(ok.status).toBe(200)
    await expect(code).resolves.toBe('abc')
  })

  it('answers 405 to POST and 404 to other paths', async () => {
    const { redirectUri, code } = await start()
    const state = settled(code)
    expect((await fetch(`${redirectUri}?code=abc&state=good-state`, { method: 'POST' })).status).toBe(405)
    expect((await fetch(redirectUri.replace('/callback', '/other?code=abc&state=good-state'))).status).toBe(404)
    expect(state()).toBe('pending')
  })

  it('answers 400 when the code is missing', async () => {
    const { redirectUri } = await start()
    expect((await fetch(`${redirectUri}?state=good-state`)).status).toBe(400)
  })

  it('resolves with the code, replies with minimal html and closes the server', async () => {
    const { redirectUri, code } = await start()
    const res = await fetch(`${redirectUri}?code=the-code&state=good-state`)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('<html')
    await expect(code).resolves.toBe('the-code')
    await expect(fetch(`${redirectUri}?code=x&state=good-state`)).rejects.toThrow()
  })

  it('rejects with denied when the user refuses', async () => {
    const { redirectUri, code } = await start()
    const assertion = expect(code).rejects.toMatchObject({ code: 'denied' })
    await fetch(`${redirectUri}?error=access_denied&state=good-state`)
    await assertion
  })

  it('rejects with timeout after the lifetime and stops listening', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { redirectUri, code } = await start(300_000)
    const assertion = expect(code).rejects.toBeInstanceOf(GmailAuthError)
    await vi.advanceTimersByTimeAsync(299_999)
    await vi.advanceTimersByTimeAsync(2)
    await assertion
    await expect(code).rejects.toMatchObject({ code: 'timeout' })
    vi.useRealTimers()
    await expect(fetch(`${redirectUri}?code=x&state=good-state`)).rejects.toThrow()
  })

  it('close() rejects a pending wait with cancelled', async () => {
    const { code, close } = await start()
    const assertion = expect(code).rejects.toMatchObject({ code: 'cancelled' })
    close()
    await assertion
  })
})
