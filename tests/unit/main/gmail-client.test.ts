import { describe, expect, it, vi } from 'vitest'
import type { GmailFetch } from '../../../src/main/gmail/gmail-auth'
import { createGmailClient, GmailApiError, type GmailApiErrorCode } from '../../../src/main/gmail/gmail-client'

const extractFailure = vi.hoisted(() => ({ on: false }))
vi.mock('../../../src/main/gmail/message-text', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/gmail/message-text')>()
  return {
    ...real,
    extractMessage: (payload: Parameters<typeof real.extractMessage>[0]) => {
      if (extractFailure.on) throw new RangeError('Maximum call stack size exceeded')
      return real.extractMessage(payload)
    },
  }
})

const API = 'https://gmail.test'
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

const metadata = (id: string, headers: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  id,
  threadId: `t-${id}`,
  snippet: `snippet ${id}`,
  labelIds: ['INBOX'],
  internalDate: '1762851600000', // 2025-11-11T09:00:00.000Z
  payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
  ...extra,
})

type Route = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>

const setup = (route: Route, options: { onUnauthorized?: () => Promise<boolean> } = {}) => {
  let token = 'AT1'
  const fetchMock = vi.fn<GmailFetch>(async (url, init) => route(new URL(url), init))
  const onUnauthorized = vi.fn(
    options.onUnauthorized ??
      (async () => {
        token = 'AT2'
        return true
      }),
  )
  const client = createGmailClient({ fetch: fetchMock, apiBase: API, getAccessToken: async () => token, onUnauthorized })
  return { client, fetchMock, onUnauthorized }
}

const expectCode = async (promise: Promise<unknown>, code: GmailApiErrorCode) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(GmailApiError)
  expect((error as GmailApiError).code).toBe(code)
}

describe('gmail client: unreadIds', () => {
  it('asks for the unread messages of Primary with the exact query and bearer token', async () => {
    const { client, fetchMock } = setup(() => json({ messages: [{ id: 'a', threadId: 'a' }] }))
    await expect(client.unreadIds()).resolves.toEqual(['a'])
    const [url, init] = fetchMock.mock.calls[0]!
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe(`${API}/gmail/v1/users/me/messages`)
    expect(parsed.searchParams.get('q')).toBe('in:inbox category:primary is:unread')
    expect(parsed.searchParams.get('maxResults')).toBe('100')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer AT1')
  })

  it('returns the ids in list order, at most 100, and [] without messages', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => ({ id: `m${i}`, threadId: `t${i}` }))
    const result = await setup(() => json({ messages: ids })).client.unreadIds()
    expect(result).toHaveLength(100)
    expect(result.slice(0, 2)).toEqual(['m0', 'm1'])
    await expect(setup(() => json({ resultSizeEstimate: 0 })).client.unreadIds()).resolves.toEqual([])
  })
})

describe('gmail client: recent', () => {
  const listRoute =
    (ids: string[], meta: (id: string) => unknown): Route =>
    (url) => {
      if (url.pathname.endsWith('/messages')) return json({ messages: ids.map((id) => ({ id, threadId: `t-${id}` })) })
      const id = url.pathname.split('/').pop()!
      const body = meta(id)
      return body === null ? json({ error: { code: 404 } }, 404) : json(body)
    }

  it('lists the 5 most recent of Primary and asks metadata with From, Subject and Date', async () => {
    const ids = ['m1', 'm2', 'm3', 'm4', 'm5']
    const { client, fetchMock } = setup(
      listRoute(ids, (id) => metadata(id, { From: `Ana ${id} <a@x>`, Subject: `Asunto ${id}`, Date: 'Tue, 11 Nov 2025 10:00:00 +0000' })),
    )
    const messages = await client.recent()

    const list = new URL(fetchMock.mock.calls[0]![0])
    expect(list.pathname).toBe('/gmail/v1/users/me/messages')
    expect(list.searchParams.get('q')).toBe('in:inbox category:primary')
    expect(list.searchParams.get('maxResults')).toBe('5')

    const metaUrls = fetchMock.mock.calls.slice(1).map(([url]) => new URL(url))
    expect(metaUrls.map((u) => u.pathname)).toEqual(ids.map((id) => `/gmail/v1/users/me/messages/${id}`))
    for (const url of metaUrls) {
      expect(url.searchParams.get('format')).toBe('metadata')
      expect(url.searchParams.getAll('metadataHeaders')).toEqual(['From', 'Subject', 'Date'])
    }

    expect(messages.map((m) => m.id)).toEqual(ids)
    expect(messages[0]).toEqual({
      id: 'm1',
      threadId: 't-m1',
      from: 'Ana m1',
      subject: 'Asunto m1',
      snippet: 'snippet m1',
      date: '2025-11-11T10:00:00.000Z',
      unread: false,
    })
  })

  it('keeps the list order even when metadata arrives out of order', async () => {
    const delays: Record<string, number> = { m1: 30, m2: 0, m3: 10 }
    const slow = createGmailClient({
      fetch: async (url, init) => {
        const id = new URL(url).pathname.split('/').pop()!
        await new Promise((r) => setTimeout(r, delays[id] ?? 0))
        return listRoute(['m1', 'm2', 'm3'], (i) => metadata(i, {}))(new URL(url), init)
      },
      apiBase: API,
      getAccessToken: async () => 'AT',
      onUnauthorized: async () => false,
    })
    expect((await slow.recent()).map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('handles odd headers: no subject, unread label, invalid or missing Date, lowercase names', async () => {
    const { client } = setup(
      listRoute(['a', 'b', 'c'], (id) =>
        id === 'a'
          ? metadata(id, { From: '"Doe, John" <j@x.com>', Date: 'not a date' }, { labelIds: ['INBOX', 'UNREAD'] })
          : id === 'b'
            ? metadata(id, { from: '<b@x>', subject: 'Hola' }, { labelIds: undefined })
            : metadata(id, { From: 'c@x', Subject: 'It&#39;s fine', Date: '' }, { snippet: 'a &amp; b' }),
      ),
    )
    const [a, b, c] = await client.recent()
    expect(a).toMatchObject({ from: 'Doe, John', subject: '', date: '2025-11-11T09:00:00.000Z', unread: true })
    expect(b).toMatchObject({ from: 'b@x', subject: 'Hola', date: '2025-11-11T09:00:00.000Z', unread: false })
    // Subjects are header text, not HTML: never decoded. Snippets come HTML-escaped from Gmail.
    expect(c).toMatchObject({ from: 'c@x', subject: 'It&#39;s fine', snippet: 'a & b' })
  })

  it('drops messages deleted between the list and their metadata (404)', async () => {
    const { client } = setup(
      listRoute(['a', 'gone', 'c'], (id) => (id === 'gone' ? null : metadata(id, {}))),
    )
    expect((await client.recent()).map((m) => m.id)).toEqual(['a', 'c'])
  })

  it('returns an empty list when Primary is empty', async () => {
    const { client, fetchMock } = setup(() => json({}))
    await expect(client.recent()).resolves.toEqual([])
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('rejects metadata without a usable date as invalid-response', async () => {
    const { client } = setup(listRoute(['a'], (id) => metadata(id, {}, { internalDate: 'nope' })))
    await expectCode(client.recent(), 'invalid-response')
  })
})

describe('gmail client: profile', () => {
  it('returns the account address', async () => {
    const { client, fetchMock } = setup(() => json({ emailAddress: 'me@x.com', messagesTotal: 3 }))
    await expect(client.profile()).resolves.toBe('me@x.com')
    expect(new URL(fetchMock.mock.calls[0]![0]).pathname).toBe('/gmail/v1/users/me/profile')
  })
})

describe('gmail client: errors', () => {
  it('on 401 refreshes once and repeats with the new token', async () => {
    let calls = 0
    const { client, fetchMock, onUnauthorized } = setup(() => (++calls === 1 ? json({}, 401) : json({ messages: [] })))
    await expect(client.unreadIds()).resolves.toEqual([])
    expect(onUnauthorized).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(new Headers(fetchMock.mock.calls[1]![1]?.headers).get('authorization')).toBe('Bearer AT2')
  })

  it('a second 401 is unauthorized, without looping', async () => {
    const { client, fetchMock, onUnauthorized } = setup(() => json({}, 401))
    await expectCode(client.unreadIds(), 'unauthorized')
    expect(onUnauthorized).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a refused refresh is unauthorized without repeating the request', async () => {
    const { client, fetchMock, onUnauthorized } = setup(() => json({}, 401), { onUnauthorized: async () => false })
    await expectCode(client.unreadIds(), 'unauthorized')
    expect(onUnauthorized).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('maps 429 and 403 to rate-limited, 5xx to server, other 4xx to invalid-response', async () => {
    await expectCode(setup(() => json({}, 429)).client.unreadIds(), 'rate-limited')
    await expectCode(setup(() => json({}, 403)).client.unreadIds(), 'rate-limited')
    await expectCode(setup(() => json({}, 500)).client.unreadIds(), 'server')
    await expectCode(setup(() => json({}, 503)).client.profile(), 'server')
    await expectCode(setup(() => json({}, 404)).client.unreadIds(), 'invalid-response')
  })

  it('maps a thrown fetch to network', async () => {
    await expectCode(
      setup(() => {
        throw new TypeError('fetch failed')
      }).client.unreadIds(),
      'network',
    )
  })

  it('maps bodies that are not JSON or do not match the schema to invalid-response', async () => {
    await expectCode(setup(() => new Response('<html>', { status: 200 })).client.unreadIds(), 'invalid-response')
    await expectCode(setup(() => json({ messages: [{ id: 1 }] })).client.unreadIds(), 'invalid-response')
    await expectCode(setup(() => json({ email: 'x' })).client.profile(), 'invalid-response')
  })

  it('carries only the code in the error message', async () => {
    const { client } = setup(() => json({ error: { message: 'secret subject' } }, 500))
    const error = (await client.unreadIds().catch((e: unknown) => e)) as Error
    expect(error.message).not.toContain('secret')
    expect(error.message).not.toContain('AT1')
  })
})

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url')

const full = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  threadId: `t-${id}`,
  labelIds: ['INBOX', 'UNREAD'],
  internalDate: '1762851600000',
  payload: {
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'From', value: 'Ana García <ana@example.com>' },
      { name: 'Subject', value: 'Presupuesto' },
      { name: 'Date', value: 'Tue, 11 Nov 2025 10:00:00 +0000' },
    ],
    body: { size: 0 },
    parts: [
      { mimeType: 'text/plain', headers: [], body: { size: 10, data: b64('Hola, mira https://example.com/a') } },
      { mimeType: 'application/pdf', filename: 'doc.pdf', headers: [], body: { size: 100 } },
    ],
  },
  ...extra,
})

describe('gmail client: message', () => {
  it('asks format=full and builds the detail: sender name and address, subject, date, unread, text, links, attachments', async () => {
    const { client, fetchMock } = setup(() => json(full('m1')))
    const detail = await client.message('m1')
    const url = new URL(fetchMock.mock.calls[0]![0])
    expect(url.pathname).toBe('/gmail/v1/users/me/messages/m1')
    expect(url.searchParams.get('format')).toBe('full')
    expect(detail).toEqual({
      id: 'm1',
      threadId: 't-m1',
      from: 'Ana García',
      fromAddress: 'ana@example.com',
      subject: 'Presupuesto',
      date: '2025-11-11T10:00:00.000Z',
      unread: true,
      body: 'Hola, mira https://example.com/a',
      truncated: false,
      links: [{ text: 'https://example.com/a', url: 'https://example.com/a' }],
      attachments: 1,
    })
  })

  it('reads a message without labels as read, without subject as empty, the date from internalDate', async () => {
    const message = full('m2', { labelIds: undefined })
    message.payload.headers = [{ name: 'From', value: 'solo@example.com' }]
    const detail = await setup(() => json(message)).client.message('m2')
    expect(detail).toMatchObject({ from: 'solo@example.com', fromAddress: 'solo@example.com', subject: '', unread: false, date: '2025-11-11T09:00:00.000Z' })
  })

  it('cuts sender and subject to 1000 characters so a valid mail never fails validation', async () => {
    const message = full('m3')
    const name = 'N'.repeat(1500)
    const address = `${'a'.repeat(1500)}@example.com`
    message.payload.headers = [
      { name: 'From', value: `${name} <${address}>` },
      { name: 'Subject', value: 'S'.repeat(5000) },
    ]
    const detail = await setup(() => json(message)).client.message('m3')
    expect(detail.from).toBe('N'.repeat(1000))
    expect(detail.fromAddress).toBe('a'.repeat(1000))
    expect(detail.subject).toBe('S'.repeat(1000))
  })

  it('encodes the id in the path', async () => {
    const { client, fetchMock } = setup(() => json(full('a/b')))
    await client.message('a/b')
    expect(new URL(fetchMock.mock.calls[0]![0]).pathname).toBe('/gmail/v1/users/me/messages/a%2Fb')
  })

  it('a 404 is not-found; a bad body is invalid-response', async () => {
    await expectCode(setup(() => json({}, 404)).client.message('x'), 'not-found')
    await expectCode(setup(() => json({ id: 'x' })).client.message('x'), 'invalid-response')
  })

  it('an extraction failure is invalid-response, never a crash', async () => {
    extractFailure.on = true
    try {
      await expectCode(setup(() => json(full('m1'))).client.message('m1'), 'invalid-response')
    } finally {
      extractFailure.on = false
    }
  })

  it('on 401 refreshes once and repeats', async () => {
    let calls = 0
    const { client, onUnauthorized } = setup(() => (++calls === 1 ? json({}, 401) : json(full('m1'))))
    await expect(client.message('m1')).resolves.toMatchObject({ id: 'm1' })
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })
})

describe('gmail client: markRead and remove', () => {
  it('markRead posts modify with removeLabelIds UNREAD', async () => {
    const { client, fetchMock } = setup(() => json({ id: 'm1', labelIds: ['INBOX'] }))
    await expect(client.markRead('m1')).resolves.toBeUndefined()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(new URL(url).pathname).toBe('/gmail/v1/users/me/messages/m1/modify')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer AT1')
    expect(JSON.parse(String(init?.body))).toEqual({ removeLabelIds: ['UNREAD'] })
  })

  it('remove sends DELETE on the message (permanent)', async () => {
    const { client, fetchMock } = setup(() => new Response(null, { status: 204 }))
    await expect(client.remove('m1')).resolves.toBeUndefined()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(new URL(url).pathname).toBe('/gmail/v1/users/me/messages/m1')
    expect(init?.method).toBe('DELETE')
  })

  it('a 404 counts as done for both', async () => {
    await expect(setup(() => json({}, 404)).client.markRead('gone')).resolves.toBeUndefined()
    await expect(setup(() => json({}, 404)).client.remove('gone')).resolves.toBeUndefined()
  })

  it('on 401 refreshes once and repeats with the new token', async () => {
    let calls = 0
    const { client, fetchMock, onUnauthorized } = setup(() => (++calls === 1 ? json({}, 401) : new Response(null, { status: 204 })))
    await client.remove('m1')
    expect(onUnauthorized).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]![1]?.method).toBe('DELETE')
    expect(new Headers(fetchMock.mock.calls[1]![1]?.headers).get('authorization')).toBe('Bearer AT2')
    await expectCode(setup(() => json({}, 401)).client.markRead('m1'), 'unauthorized')
  })

  it('maps other failures like the reads', async () => {
    await expectCode(setup(() => json({}, 500)).client.remove('m1'), 'server')
    await expectCode(setup(() => json({}, 429)).client.markRead('m1'), 'rate-limited')
    await expectCode(
      setup(() => {
        throw new TypeError('fetch failed')
      }).client.remove('m1'),
      'network',
    )
  })
})
