import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Local stand-in for Google's OAuth endpoints and the Gmail API (E2E only), reached by the app
 * through NOTCH_GMAIL_BASE_URL. It plays Google strictly: the consent screen issues a code bound to
 * the PKCE challenge and redirect URI, `/token` checks the grant type, the client and the verifier,
 * and every API call must carry a bearer token it issued. Anything off is recorded in `violations`
 * (and refused), so a test can assert the app spoke the protocol correctly. Reads (`format=full`),
 * mark-read (`modify`) and permanent deletes (`DELETE`) act on an in-memory mailbox and are
 * recorded; `addMail` drops a new unread message in. All data is fictional (example.* domains).
 */

export const FAKE_CLIENT_ID = 'e2e-fake-client.apps.example.test'
export const FAKE_CLIENT_SECRET = 'e2e-fake-client-secret'
export const FAKE_ACCOUNT = 'usuario.prueba@example.com'
export const GMAIL_SCOPE = 'https://mail.google.com/'
/** What a milestone-1 consent granted: the notch must refuse it (`reason: 'scope'`). */
export const READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

/** The body a `format=full` request returns (MIME parts are built from it, base64url like Gmail). */
export type FakeBody =
  /** multipart/alternative: text/plain (the one the notch shows) and its text/html twin. */
  | { kind: 'text'; text: string }
  /** A lone text/html part (no text/plain): the notch converts it to text. */
  | { kind: 'html'; html: string }
  /** multipart/mixed: text/plain plus one attachment. */
  | { kind: 'attachment'; text: string; filename: string }

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
  /** Body for `format=full`; without one, the snippet as text/plain. */
  body?: FakeBody
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
    body: {
      kind: 'text',
      text: [
        'Hola:',
        '',
        'Te dejo los comentarios sobre la vista de Gmail y el ancho de la fila.',
        'La lectura se ve bien; el pie podría ir un poco más separado.',
        '',
        'Notas completas: https://docs.example.com/notch/gmail-revision',
        '',
        'Un saludo,',
        'Ana',
      ].join('\r\n'),
    },
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
    body: {
      kind: 'html',
      html: [
        '<html><head><style>p { color: red }</style><script>window.stolen = 1</script></head><body>',
        '<p>¿Te viene bien a las nueve? Reservo para cuatro &amp; aviso al resto.</p>',
        '<p><a href="https://reservas.example.org/viernes?mesa=4">Ver la reserva</a></p>',
        '<p><a href="javascript:alert(1)">Pulsa aquí</a></p>',
        '<p><img src="https://img.example.org/mesa.png" alt=""></p>',
        '</body></html>',
      ].join(''),
    },
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
    body: { kind: 'attachment', text: 'Ya puedes descargar la factura desde tu área de cliente.\r\nTe la adjuntamos también en PDF.', filename: 'factura-noviembre.pdf' },
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
  /**
   * True: tokens (sign-in and refresh) carry only `gmail.readonly`, as if the user unticked the
   * full-mail box on the consent screen (or a milestone-1 grant); the notch must refuse them.
   */
  grantReadonlyScope: boolean
  /** Ids marked read through `POST messages/{id}/modify`, in order. */
  readonly modified: string[]
  /** Ids deleted for good through `DELETE messages/{id}`, in order. */
  readonly deleted: string[]
  /** The mailbox now, newest first (deleted messages are gone, read ones lose `unread`). */
  readonly mailbox: readonly FakeMessage[]
  /** A new unread message arrives at the top of Primary (the next poll sees it). */
  addMail(message: Omit<FakeMessage, 'unread' | 'minutesAgo'>): void
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

const b64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url')
const escapeHtml = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

interface Part {
  partId: string
  mimeType: string
  filename: string
  headers: { name: string; value: string }[]
  body: { size: number; data?: string; attachmentId?: string }
  parts?: Part[]
}

const textPart = (partId: string, mimeType: 'text/plain' | 'text/html', content: string): Part => ({
  partId,
  mimeType,
  filename: '',
  headers: [
    { name: 'Content-Type', value: `${mimeType}; charset="UTF-8"` },
    { name: 'Content-Transfer-Encoding', value: 'quoted-printable' },
  ],
  body: { size: Buffer.byteLength(content), data: b64url(content) },
})

const multipart = (mimeType: string, parts: Part[]): Part => ({
  partId: '',
  mimeType,
  filename: '',
  headers: [{ name: 'Content-Type', value: `${mimeType}; boundary="fake-boundary"` }],
  body: { size: 0 },
  parts,
})

/** The MIME tree of a `format=full` answer, the way Gmail shapes it (the caller adds the mail headers). */
const mimeTree = (message: FakeMessage): Part => {
  const body = message.body ?? { kind: 'text', text: message.snippet.replaceAll('&amp;', '&') }
  if (body.kind === 'html') return textPart('', 'text/html', body.html)
  if (body.kind === 'text') {
    const html = `<div dir="ltr">${escapeHtml(body.text).replaceAll('\r\n', '<br>')}</div>`
    return multipart('multipart/alternative', [textPart('0', 'text/plain', body.text), textPart('1', 'text/html', html)])
  }
  const pdf = '%PDF-1.4 fictional attachment'
  return multipart('multipart/mixed', [
    textPart('0', 'text/plain', body.text),
    {
      partId: '1',
      mimeType: 'application/pdf',
      filename: body.filename,
      headers: [
        { name: 'Content-Type', value: `application/pdf; name="${body.filename}"` },
        { name: 'Content-Disposition', value: `attachment; filename="${body.filename}"` },
      ],
      body: { size: pdf.length, attachmentId: 'ANGjdJ_fake_attachment' },
    },
  ])
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
  const modified: string[] = []
  const deleted: string[] = []
  const state = { unauthorized: false, readonly: false }
  // A mutable copy: actions change the mailbox; FAKE_MESSAGES stays the seed.
  let mailbox: FakeMessage[] = FAKE_MESSAGES.map((m) => ({ ...m }))
  const grantedScope = () => (state.readonly ? READONLY_SCOPE : GMAIL_SCOPE)

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
    if (p.get('scope') !== GMAIL_SCOPE) return refuse(res, 400, 'auth: scope is not full mail access')
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
      return json(res, 200, { access_token: issueAccess(), expires_in: 3599, refresh_token: refresh, scope: grantedScope(), token_type: 'Bearer' })
    }
    if (grant === 'refresh_token') {
      if (!refreshTokens.has(form.get('refresh_token') ?? '')) return refuse(res, 400, 'token: unknown refresh token')
      // A revoked or expired grant: Google answers 400 invalid_grant (not a protocol mistake).
      if (state.unauthorized) return json(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
      return json(res, 200, { access_token: issueAccess(), expires_in: 3599, scope: grantedScope(), token_type: 'Bearer' })
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

  const metadata = (message: FakeMessage, full = false) => {
    const date = new Date(startedAt - message.minutesAgo * 60_000)
    const headers = [
      { name: 'From', value: message.from },
      { name: 'Subject', value: message.subject },
      { name: 'Date', value: date.toUTCString() },
    ]
    const labelIds = message.unread ? ['UNREAD', 'CATEGORY_PERSONAL', 'INBOX'] : ['CATEGORY_PERSONAL', 'INBOX']
    if (full) {
      return {
        id: message.id,
        threadId: message.threadId,
        labelIds,
        snippet: message.snippet,
        historyId: '1000',
        internalDate: String(date.getTime()),
        sizeEstimate: 4096,
        payload: (() => {
          const tree = mimeTree(message)
          return {
            ...tree,
            headers: [
              { name: 'MIME-Version', value: '1.0' },
              { name: 'To', value: FAKE_ACCOUNT },
              ...headers,
              { name: 'Message-ID', value: `<${message.id}@example.com>` },
              ...tree.headers,
            ],
          }
        })(),
      }
    }
    return {
      id: message.id,
      threadId: message.threadId,
      labelIds,
      snippet: message.snippet,
      historyId: '1000',
      internalDate: String(date.getTime()),
      sizeEstimate: 2048,
      payload: {
        mimeType: 'multipart/alternative',
        headers,
      },
    }
  }

  const notFound = (res: ServerResponse) => json(res, 404, { error: { code: 404, message: 'Requested entity was not found.' } })

  const api = async (req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> => {
    const path = url.pathname.slice('/gmail/v1/users/me/'.length)
    const auth = req.headers.authorization ?? ''
    const bearer = /^Bearer (\S+)$/.exec(auth)?.[1]
    if (state.unauthorized) {
      hit(`${req.method ?? '?'} ${path.startsWith('messages/') ? 'message' : path} 401`)
      return json(res, 401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } })
    }
    if (!bearer || !accessTokens.has(bearer)) {
      return refuse(res, 401, `api: ${path} without a valid bearer token`)
    }

    const modify = /^messages\/([^/]+)\/modify$/.exec(path)
    if (modify) {
      hit('POST modify')
      if (req.method !== 'POST') return refuse(res, 405, `api: ${req.method ?? '?'} ${path}`)
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return refuse(res, 400, 'api: modify body is not JSON')
      let change: { addLabelIds?: unknown; removeLabelIds?: unknown }
      try {
        change = JSON.parse(await readBody(req)) as typeof change
      } catch {
        return refuse(res, 400, 'api: modify body is not JSON')
      }
      // The notch only ever marks as read: remove UNREAD, add nothing.
      if (JSON.stringify(change.removeLabelIds) !== JSON.stringify(['UNREAD']) || change.addLabelIds !== undefined) {
        return refuse(res, 400, 'api: modify is not "remove UNREAD"')
      }
      const id = decodeURIComponent(modify[1] ?? '')
      const message = mailbox.find((m) => m.id === id)
      if (!message) return notFound(res)
      message.unread = false
      modified.push(id)
      return json(res, 200, { id, threadId: message.threadId, labelIds: ['CATEGORY_PERSONAL', 'INBOX'] })
    }
    if (req.method === 'DELETE') {
      hit('DELETE message')
      const target = /^messages\/([^/]+)$/.exec(path)
      if (!target) return refuse(res, 405, `api: DELETE ${path}`)
      const id = decodeURIComponent(target[1] ?? '')
      if (!mailbox.some((m) => m.id === id)) return notFound(res)
      mailbox = mailbox.filter((m) => m.id !== id)
      deleted.push(id)
      res.writeHead(204, { 'cache-control': 'no-store' })
      res.end()
      return
    }
    if (req.method !== 'GET') return refuse(res, 405, `api: ${req.method ?? '?'} ${path}`)

    if (path === 'profile') {
      hit('GET profile')
      return json(res, 200, { emailAddress: FAKE_ACCOUNT, messagesTotal: mailbox.length, threadsTotal: mailbox.length, historyId: '1000' })
    }
    if (path === 'messages') {
      hit('GET messages')
      const q = url.searchParams.get('q') ?? ''
      if (!q.includes('in:inbox') || !q.includes('category:primary')) return refuse(res, 400, 'api: list query is not Primary')
      const max = Number(url.searchParams.get('maxResults') ?? '100')
      const matching = q.includes('is:unread') ? mailbox.filter((m) => m.unread) : mailbox
      const page = matching.slice(0, max).map(({ id, threadId }) => ({ id, threadId }))
      return json(res, 200, page.length ? { messages: page, resultSizeEstimate: matching.length } : { resultSizeEstimate: 0 })
    }
    const single = /^messages\/([^/]+)$/.exec(path)
    if (single) {
      const format = url.searchParams.get('format')
      hit(format === 'full' ? 'GET message full' : 'GET message')
      if (format !== 'metadata' && format !== 'full') return refuse(res, 400, 'api: message not asked as metadata or full')
      const message = mailbox.find((m) => m.id === decodeURIComponent(single[1] ?? ''))
      if (!message) return notFound(res)
      return json(res, 200, metadata(message, format === 'full'))
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
    get grantReadonlyScope() {
      return state.readonly
    },
    set grantReadonlyScope(value: boolean) {
      state.readonly = value
    },
    violations,
    hits,
    issuedTokens,
    modified,
    deleted,
    get mailbox() {
      return mailbox
    },
    addMail(message) {
      // Arrives now, the newest of all (minutes are counted back from the server's start).
      mailbox = [{ ...message, unread: true, minutesAgo: -(Date.now() - startedAt) / 60_000 }, ...mailbox]
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
