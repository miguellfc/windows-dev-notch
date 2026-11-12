import { describe, expect, it, vi } from 'vitest'
import type { GmailFetch } from '../../../src/main/gmail/gmail-auth'
import { createGmailClient, GmailApiError, type GmailApiErrorCode } from '../../../src/main/gmail/gmail-client'

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

describe('gmail client: unreadCount', () => {
  it('asks for the unread messages of Primary with the exact query and bearer token', async () => {
    const { client, fetchMock } = setup(() => json({ messages: [{ id: 'a', threadId: 'a' }] }))
    await expect(client.unreadCount()).resolves.toBe(1)
    const [url, init] = fetchMock.mock.calls[0]!
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe(`${API}/gmail/v1/users/me/messages`)
    expect(parsed.searchParams.get('q')).toBe('in:inbox category:primary is:unread')
    expect(parsed.searchParams.get('maxResults')).toBe('100')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer AT1')
  })

  it('counts 100 ids as 100 and no messages as 0', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, threadId: `t${i}` }))
    await expect(setup(() => json({ messages: ids })).client.unreadCount()).resolves.toBe(100)
    await expect(setup(() => json({ resultSizeEstimate: 0 })).client.unreadCount()).resolves.toBe(0)
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
    await expect(client.unreadCount()).resolves.toBe(0)
    expect(onUnauthorized).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(new Headers(fetchMock.mock.calls[1]![1]?.headers).get('authorization')).toBe('Bearer AT2')
  })

  it('a second 401 is unauthorized, without looping', async () => {
    const { client, fetchMock, onUnauthorized } = setup(() => json({}, 401))
    await expectCode(client.unreadCount(), 'unauthorized')
    expect(onUnauthorized).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a refused refresh is unauthorized without repeating the request', async () => {
    const { client, fetchMock, onUnauthorized } = setup(() => json({}, 401), { onUnauthorized: async () => false })
    await expectCode(client.unreadCount(), 'unauthorized')
    expect(onUnauthorized).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('maps 429 and 403 to rate-limited, 5xx to server, other 4xx to invalid-response', async () => {
    await expectCode(setup(() => json({}, 429)).client.unreadCount(), 'rate-limited')
    await expectCode(setup(() => json({}, 403)).client.unreadCount(), 'rate-limited')
    await expectCode(setup(() => json({}, 500)).client.unreadCount(), 'server')
    await expectCode(setup(() => json({}, 503)).client.profile(), 'server')
    await expectCode(setup(() => json({}, 404)).client.unreadCount(), 'invalid-response')
  })

  it('maps a thrown fetch to network', async () => {
    await expectCode(
      setup(() => {
        throw new TypeError('fetch failed')
      }).client.unreadCount(),
      'network',
    )
  })

  it('maps bodies that are not JSON or do not match the schema to invalid-response', async () => {
    await expectCode(setup(() => new Response('<html>', { status: 200 })).client.unreadCount(), 'invalid-response')
    await expectCode(setup(() => json({ messages: [{ id: 1 }] })).client.unreadCount(), 'invalid-response')
    await expectCode(setup(() => json({ email: 'x' })).client.profile(), 'invalid-response')
  })

  it('carries only the code in the error message', async () => {
    const { client } = setup(() => json({ error: { message: 'secret subject' } }, 500))
    const error = (await client.unreadCount().catch((e: unknown) => e)) as Error
    expect(error.message).not.toContain('secret')
    expect(error.message).not.toContain('AT1')
  })
})
