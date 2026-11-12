import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Local stand-in for Google's OAuth endpoints and the Gmail API (E2E only), reached by the app
 * through NOTCH_GMAIL_BASE_URL. It plays Google strictly: the consent screen issues a code bound to
 * the PKCE challenge and redirect URI, `/token` checks the grant type, the client and the verifier,
 * and every API call must carry a bearer token it issued. Anything off is recorded in `violations`
 * (and refused), so a test can assert the app spoke the protocol correctly. All data is fictional.
 */

export const FAKE_CLIENT_ID = 'e2e-fake-client.apps.example.test'
export const FAKE_CLIENT_SECRET = 'e2e-fake-client-secret'
export const FAKE_ACCOUNT = 'usuario.prueba@example.com'
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

export interface FakeMessage {
  id: string
  threadId: string
  /** Raw `From` header. */
  from: string
  /** What the notch shows for `from` (display name, or the address without one). */
  sender: string
  subject: string
  snippet: string
  unread: boolean
  minutesAgo: number
}

const MIN = 1
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Seven messages in Primary, newest first; three unread (two of them among the five most recent). */
export const FAKE_MESSAGES: readonly FakeMessage[] = [
  {
    id: '18c0a1',
    threadId: '18c0a1f0',
    from: '"Ana Ejemplo" <ana@example.com>',
    sender: 'Ana Ejemplo',
    subject: 'Revisión del diseño de la cápsula',
    snippet: 'Te dejo los comentarios sobre la vista de Gmail y el ancho de la fila.',
    unread: true,
    minutesAgo: 2 * MIN,
  },
  {
    id: '18c0a2',
    threadId: '18c0a2f0',
    from: 'Equipo de Builds <builds@example.com>',
    sender: 'Equipo de Builds',
    subject: 'Compilación nocturna correcta',
    snippet: 'Todas las pruebas pasaron en 4 min 12 s.',
    unread: false,
    minutesAgo: 25 * MIN,
  },
  {
    id: '18c0a3',
    threadId: '18c0a3f0',
    from: 'Luis Prueba <luis@example.org>',
    sender: 'Luis Prueba',
    subject: 'Cena del viernes',
    snippet: 'Te viene bien a las nueve? Reservo para cuatro &amp; aviso al resto.',
    unread: true,
    minutesAgo: 3 * HOUR,
  },
  {
    id: '18c0a4',
    threadId: '18c0a4f0',
    from: 'facturas@example.com',
    sender: 'facturas@example.com',
    subject: 'Tu factura de noviembre',
    snippet: 'Ya puedes descargar la factura desde tu área de cliente.',
    unread: false,
    minutesAgo: 26 * HOUR,
  },
  {
    id: '18c0a5',
    threadId: '18c0a5f0',
    from: '"Calendario" <calendario@example.com>',
    sender: 'Calendario',
    subject: 'Recordatorio: demo del jueves',
    snippet: 'Jueves a las 10:00 · Sala grande',
    unread: false,
    minutesAgo: 3 * DAY,
  },
  {
    id: '18c0a6',
    threadId: '18c0a6f0',
    from: 'Marta Ficticia <marta@example.net>',
    sender: 'Marta Ficticia',
    subject: 'Fotos del viaje',
    snippet: 'Subí las fotos a la carpeta compartida.',
    unread: true,
    minutesAgo: 5 * DAY,
  },
  {
    id: '18c0a7',
    threadId: '18c0a7f0',
    from: 'Boletín Semanal <boletin@example.com>',
    sender: 'Boletín Semanal',
    subject: 'Novedades de la semana',
    snippet: 'Lo más leído de los últimos siete días.',
    unread: false,
    minutesAgo: 8 * DAY,
  },
]

export interface FakeGmail {
  /** Origin to pass as NOTCH_GMAIL_BASE_URL. */
  readonly base: string
  /** True: API calls answer 401 and refresh grants answer `invalid_grant` (a revoked session). */
  unauthorized: boolean
  /** Protocol mistakes seen so far (refused requests); a correct client leaves this empty. */
  readonly violations: string[]
  /** Requests per route ("POST /token:authorization_code", "GET messages", …). */
  readonly hits: Record<string, number>
  /** Every token the server handed out (access and refresh), to check none reached a log file. */
  readonly issuedTokens: string[]
  close(): Promise<void>
}

interface PendingCode {
  challenge: string
  redirectUri: string
  clientId: string
}

const sha256url = (value: string): string => createHash('sha256').update(value).digest('base64url')
const token = (prefix: string): string => `${prefix}-${randomBytes(12).toString('hex')}`

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

export async function startFakeGmail(): Promise<FakeGmail> {
  const startedAt = Date.now()
  const codes = new Map<string, PendingCode>()
  const refreshTokens = new Set<string>()
  const accessTokens = new Set<string>()
  const violations: string[] = []
  const hits: Record<string, number> = {}
  const issuedTokens: string[] = []
  const state = { unauthorized: false }

  const hit = (key: string) => {
    hits[key] = (hits[key] ?? 0) + 1
  }
  const refuse = (res: ServerResponse, status: number, violation: string): void => {
    violations.push(violation)
    json(res, status, { error: 'invalid_request', error_description: violation })
  }
  const issueAccess = (): string => {
    const access = token('fake-access')
    accessTokens.add(access)
    issuedTokens.push(access)
    return access
  }

  /** Consent screen: the user "accepts" at once and the browser is sent back with a code. */
  const authorize = (url: URL, res: ServerResponse): void => {
    hit('GET auth')
    const p = url.searchParams
    const redirectUri = p.get('redirect_uri') ?? ''
    if (p.get('client_id') !== FAKE_CLIENT_ID) return refuse(res, 400, 'auth: unknown client_id')
    if (p.get('response_type') !== 'code') return refuse(res, 400, 'auth: response_type is not code')
    if (p.get('scope') !== GMAIL_SCOPE) return refuse(res, 400, 'auth: scope is not gmail.readonly')
    if (p.get('code_challenge_method') !== 'S256') return refuse(res, 400, 'auth: PKCE method is not S256')
    if (!/^[\w-]{43}$/.test(p.get('code_challenge') ?? '')) return refuse(res, 400, 'auth: missing PKCE challenge')
    if (!p.get('state')) return refuse(res, 400, 'auth: missing state')
    if (!/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirectUri)) return refuse(res, 400, 'auth: redirect_uri is not a loopback')
    const code = token('fake-code')
    codes.set(code, { challenge: p.get('code_challenge') ?? '', redirectUri, clientId: FAKE_CLIENT_ID })
    const back = new URL(redirectUri)
    back.searchParams.set('code', code)
    back.searchParams.set('state', p.get('state') ?? '')
    res.writeHead(302, { location: back.toString(), 'cache-control': 'no-store' })
    res.end()
  }

  const tokenEndpoint = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') return refuse(res, 405, 'token: not a POST')
    if (!(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) {
      return refuse(res, 400, 'token: body is not form-encoded')
    }
    const form = new URLSearchParams(await readBody(req))
    const grant = form.get('grant_type')
    hit(`POST /token:${grant ?? 'none'}`)
    if (form.get('client_id') !== FAKE_CLIENT_ID || form.get('client_secret') !== FAKE_CLIENT_SECRET) {
      return refuse(res, 401, 'token: wrong client credentials')
    }
    if (grant === 'authorization_code') {
      const code = form.get('code') ?? ''
      const pending = codes.get(code)
      if (!pending) return refuse(res, 400, 'token: unknown or reused code')
      codes.delete(code) // single use, like Google
      const verifier = form.get('code_verifier')
      if (!verifier) return refuse(res, 400, 'token: missing code_verifier')
      if (sha256url(verifier) !== pending.challenge) return refuse(res, 400, 'token: code_verifier does not match the challenge')
      if (form.get('redirect_uri') !== pending.redirectUri) return refuse(res, 400, 'token: redirect_uri differs from the consent request')
      const refresh = token('fake-refresh')
      refreshTokens.add(refresh)
      issuedTokens.push(refresh)
      return json(res, 200, { access_token: issueAccess(), expires_in: 3599, refresh_token: refresh, scope: GMAIL_SCOPE, token_type: 'Bearer' })
    }
    if (grant === 'refresh_token') {
      if (!refreshTokens.has(form.get('refresh_token') ?? '')) return refuse(res, 400, 'token: unknown refresh token')
      // A revoked or expired grant: Google answers 400 invalid_grant (not a protocol mistake).
      if (state.unauthorized) return json(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
      return json(res, 200, { access_token: issueAccess(), expires_in: 3599, scope: GMAIL_SCOPE, token_type: 'Bearer' })
    }
    return refuse(res, 400, `token: unsupported grant_type ${grant ?? '(none)'}`)
  }

  const revoke = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    hit('POST /revoke')
    if (req.method !== 'POST') return refuse(res, 405, 'revoke: not a POST')
    const revoked = new URLSearchParams(await readBody(req)).get('token') ?? ''
    refreshTokens.delete(revoked)
    accessTokens.delete(revoked)
    json(res, 200, {})
  }

  const metadata = (message: FakeMessage) => {
    const date = new Date(startedAt - message.minutesAgo * 60_000)
    return {
      id: message.id,
      threadId: message.threadId,
      labelIds: message.unread ? ['UNREAD', 'CATEGORY_PERSONAL', 'INBOX'] : ['CATEGORY_PERSONAL', 'INBOX'],
      snippet: message.snippet,
      historyId: '1000',
      internalDate: String(date.getTime()),
      sizeEstimate: 2048,
      payload: {
        mimeType: 'multipart/alternative',
        headers: [
          { name: 'From', value: message.from },
          { name: 'Subject', value: message.subject },
          { name: 'Date', value: date.toUTCString() },
        ],
      },
    }
  }

  const api = (req: IncomingMessage, url: URL, res: ServerResponse): void => {
    const path = url.pathname.slice('/gmail/v1/users/me/'.length)
    if (req.method !== 'GET') return refuse(res, 405, `api: ${req.method ?? '?'} ${path}`)
    const auth = req.headers.authorization ?? ''
    const bearer = /^Bearer (\S+)$/.exec(auth)?.[1]
    if (state.unauthorized) {
      hit(`GET ${path.startsWith('messages/') ? 'message' : path} 401`)
      return json(res, 401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } })
    }
    if (!bearer || !accessTokens.has(bearer)) {
      return refuse(res, 401, `api: ${path} without a valid bearer token`)
    }

    if (path === 'profile') {
      hit('GET profile')
      return json(res, 200, { emailAddress: FAKE_ACCOUNT, messagesTotal: FAKE_MESSAGES.length, threadsTotal: FAKE_MESSAGES.length, historyId: '1000' })
    }
    if (path === 'messages') {
      hit('GET messages')
      const q = url.searchParams.get('q') ?? ''
      if (!q.includes('in:inbox') || !q.includes('category:primary')) return refuse(res, 400, 'api: list query is not Primary')
      const max = Number(url.searchParams.get('maxResults') ?? '100')
      const matching = q.includes('is:unread') ? FAKE_MESSAGES.filter((m) => m.unread) : FAKE_MESSAGES
      const page = matching.slice(0, max).map(({ id, threadId }) => ({ id, threadId }))
      return json(res, 200, page.length ? { messages: page, resultSizeEstimate: matching.length } : { resultSizeEstimate: 0 })
    }
    const single = /^messages\/([^/]+)$/.exec(path)
    if (single) {
      hit('GET message')
      if (url.searchParams.get('format') !== 'metadata') return refuse(res, 400, 'api: message not asked as metadata')
      const message = FAKE_MESSAGES.find((m) => m.id === decodeURIComponent(single[1] ?? ''))
      if (!message) return json(res, 404, { error: { code: 404, message: 'Requested entity was not found.' } })
      return json(res, 200, metadata(message))
    }
    return refuse(res, 404, `api: unknown path ${path}`)
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const handle = async (): Promise<void> => {
      if (url.pathname === '/o/oauth2/v2/auth' && req.method === 'GET') return authorize(url, res)
      if (url.pathname === '/token') return tokenEndpoint(req, res)
      if (url.pathname === '/revoke') return revoke(req, res)
      if (url.pathname.startsWith('/gmail/v1/users/me/')) return api(req, url, res)
      return refuse(res, 404, `unknown route ${req.method ?? '?'} ${url.pathname}`)
    }
    handle().catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'fake server failure' })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo

  return {
    base: `http://127.0.0.1:${port}`,
    get unauthorized() {
      return state.unauthorized
    },
    set unauthorized(value: boolean) {
      state.unauthorized = value
    },
    violations,
    hits,
    issuedTokens,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
