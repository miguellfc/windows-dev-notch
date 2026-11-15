import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { GmailAuthError } from './auth-error'

export const LOOPBACK_TIMEOUT_MS = 300_000
const CALLBACK_PATH = '/callback'

export interface LoopbackOptions {
  state: string
  timeoutMs?: number
}

export interface Loopback {
  redirectUri: string
  /** Resolves with the authorization code; rejects with a `GmailAuthError`. */
  code: Promise<string>
  close(): void
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Developer Notch</title></head><body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><p>You can close this tab and go back to Developer Notch.</p></body></html>`

const reply = (res: ServerResponse, status: number, body = '', type = 'text/plain; charset=utf-8'): void => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', connection: 'close' })
  res.end(body)
}

/**
 * One-shot OAuth redirect listener on 127.0.0.1 (random port). Accepts only `GET /callback` with the
 * expected `state`; anything else is answered and ignored while it keeps waiting.
 */
export async function startLoopback({ state, timeoutMs = LOOPBACK_TIMEOUT_MS }: LoopbackOptions): Promise<Loopback> {
  let settle!: { resolve(code: string): void; reject(error: GmailAuthError): void }
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject }
  })
  // The caller may attach its handler late; never raise an unhandled rejection.
  code.catch(() => undefined)

  let finished = false
  const timer = setTimeout(() => finish(() => settle.reject(new GmailAuthError('timeout'))), timeoutMs)

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (finished) return reply(res, 410)
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== CALLBACK_PATH) return reply(res, 404)
    if (req.method !== 'GET') return reply(res, 405)
    if (url.searchParams.get('state') !== state) return reply(res, 400)

    const error = url.searchParams.get('error')
    const authCode = url.searchParams.get('code')
    if (error) {
      reply(res, 200, PAGE, 'text/html; charset=utf-8')
      return finish(() => settle.reject(new GmailAuthError(error === 'access_denied' ? 'denied' : 'invalid-response')))
    }
    if (!authCode) return reply(res, 400)
    reply(res, 200, PAGE, 'text/html; charset=utf-8')
    finish(() => settle.resolve(authCode))
  })

  function finish(settleOutcome: () => void): void {
    if (finished) return
    finished = true
    clearTimeout(timer)
    settleOutcome()
    server.close()
    // Let the in-flight reply flush, then drop idle keep-alive sockets so close() completes.
    setImmediate(() => server.closeAllConnections())
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
  } catch (error) {
    clearTimeout(timer)
    throw error
  }
  const { port } = server.address() as AddressInfo

  return {
    redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    code,
    close: () => finish(() => settle.reject(new GmailAuthError('cancelled'))),
  }
}
