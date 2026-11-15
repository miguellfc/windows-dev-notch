import { describe, expect, it } from 'vitest'
import {
  GMAIL_BODY_MAX,
  GMAIL_HEADER_MAX,
  GMAIL_URL_MAX,
  GMAIL_LINKS_MAX,
  GMAIL_RECENT_LIMIT,
  GMAIL_UNREAD_CAP,
  gmailIdInputSchema,
  gmailMessageDetailSchema,
  gmailMessageSchema,
  gmailNewMailSchema,
  gmailOpenInputSchema,
  gmailOpenLinkInputSchema,
  gmailStateSchema,
  gmailStatusSchema,
  messageFullSchema,
  messageListSchema,
  messageMetadataSchema,
  parseClientFile,
  profileSchema,
  tokenResponseSchema,
} from '../../../src/shared/gmail/schema'

const state = { status: 'ok', account: 'a@b.c', unread: 3, updatedAt: '2026-11-11T10:00:00.000Z', persistent: true, reason: null }

describe('gmail state', () => {
  it('has the documented limits', () => {
    expect(GMAIL_RECENT_LIMIT).toBe(5)
    expect(GMAIL_UNREAD_CAP).toBe(100)
  })

  it('accepts the six statuses and rejects others', () => {
    for (const status of ['unconfigured', 'signed-out', 'signing-in', 'ok', 'offline', 'expired']) {
      expect(gmailStatusSchema.safeParse(status).success, status).toBe(true)
      expect(gmailStateSchema.safeParse({ ...state, status }).success, status).toBe(true)
    }
    expect(gmailStatusSchema.safeParse('error').success).toBe(false)
    expect(gmailStateSchema.safeParse({ ...state, status: 'nope' }).success).toBe(false)
  })

  it('bounds unread to 0-100 or null', () => {
    for (const unread of [0, 100, null]) expect(gmailStateSchema.safeParse({ ...state, unread }).success).toBe(true)
    for (const unread of [-1, 101, 1.5]) expect(gmailStateSchema.safeParse({ ...state, unread }).success).toBe(false)
  })

  it('has a nullable scope reason', () => {
    expect(gmailStateSchema.safeParse({ ...state, status: 'expired', reason: 'scope' }).success).toBe(true)
    expect(gmailStateSchema.safeParse({ ...state, reason: 'other' }).success).toBe(false)
    expect(gmailStateSchema.safeParse({ ...state, reason: undefined }).success).toBe(false)
  })

  it('requires persistent and rejects unknown keys', () => {
    expect(gmailStateSchema.safeParse({ ...state, persistent: undefined }).success).toBe(false)
    expect(gmailStateSchema.safeParse({ ...state, extra: 1 }).success).toBe(false)
  })
})

describe('gmail message', () => {
  const message = { id: 'm1', threadId: 't1', from: 'Ann', subject: 's', snippet: 'x', date: '2026-11-11T10:00:00.000Z', unread: true }
  it('is strict', () => {
    expect(gmailMessageSchema.parse(message)).toEqual(message)
    expect(gmailMessageSchema.safeParse({ ...message, extra: 1 }).success).toBe(false)
    expect(gmailMessageSchema.safeParse({ ...message, unread: 'yes' }).success).toBe(false)
  })
  it('open input has an optional id', () => {
    expect(gmailOpenInputSchema.parse({})).toEqual({})
    expect(gmailOpenInputSchema.parse({ id: 'm1' })).toEqual({ id: 'm1' })
    expect(gmailOpenInputSchema.safeParse({ id: 'm1', url: 'x' }).success).toBe(false)
  })
})

describe('parseClientFile', () => {
  it('reads a desktop client file', () => {
    const json = { installed: { client_id: 'id.apps', client_secret: 'sec', project_id: 'p', auth_uri: 'u' } }
    expect(parseClientFile(json)).toEqual({ clientId: 'id.apps', clientSecret: 'sec' })
  })
  it('rejects web clients and garbage', () => {
    expect(parseClientFile({ web: { client_id: 'a', client_secret: 'b' } })).toBeNull()
    expect(parseClientFile({ installed: { client_id: '', client_secret: 'b' } })).toBeNull()
    expect(parseClientFile({ installed: { client_id: 'a' } })).toBeNull()
    for (const junk of [null, undefined, 5, 'x', [], {}]) expect(parseClientFile(junk)).toBeNull()
  })
  it('rejects ids or secrets longer than the settings allow (256)', () => {
    const long = 'x'.repeat(257)
    expect(parseClientFile({ installed: { client_id: 'a'.repeat(256), client_secret: 'b'.repeat(256) } })).not.toBeNull()
    expect(parseClientFile({ installed: { client_id: long, client_secret: 'b' } })).toBeNull()
    expect(parseClientFile({ installed: { client_id: 'a', client_secret: long } })).toBeNull()
  })
})

describe('api response schemas', () => {
  it('parse and tolerate extra fields', () => {
    expect(messageListSchema.parse({}).messages).toBeUndefined()
    expect(messageListSchema.parse({ messages: [{ id: 'a', threadId: 'b', x: 1 }], nextPageToken: 'n' }).messages).toHaveLength(1)
    const meta = {
      id: 'a', threadId: 'b', snippet: 's', internalDate: '1731319200000', extra: 1,
      payload: { headers: [{ name: 'From', value: 'x' }], mimeType: 'text/plain' },
    }
    expect(messageMetadataSchema.parse(meta).labelIds).toBeUndefined()
    expect(messageMetadataSchema.safeParse({ ...meta, payload: {} }).success).toBe(false)
    expect(profileSchema.parse({ emailAddress: 'a@b.c', messagesTotal: 4 })).toMatchObject({ emailAddress: 'a@b.c' })
    expect(tokenResponseSchema.parse({ access_token: 't', expires_in: 3599, token_type: 'Bearer', id_token: 'z' }).refresh_token).toBeUndefined()
    expect(tokenResponseSchema.safeParse({ expires_in: 1, token_type: 'Bearer' }).success).toBe(false)
  })
})

describe('gmail message detail', () => {
  const detail = {
    id: 'm1',
    threadId: 't1',
    from: 'Ana',
    fromAddress: 'ana@example.com',
    subject: 'Hola',
    date: '2026-11-11T10:00:00.000Z',
    unread: true,
    body: 'texto',
    truncated: false,
    links: [{ text: 'Docs', url: 'https://example.com/docs' }],
    attachments: 0,
  }

  it('has the documented limits', () => {
    expect(GMAIL_BODY_MAX).toBe(50_000)
    expect(GMAIL_LINKS_MAX).toBe(50)
  })

  it('is strict', () => {
    expect(gmailMessageDetailSchema.parse(detail)).toEqual(detail)
    expect(gmailMessageDetailSchema.safeParse({ ...detail, extra: 1 }).success).toBe(false)
    expect(gmailMessageDetailSchema.safeParse({ ...detail, links: [{ text: 'a', url: 'https://example.com', x: 1 }] }).success).toBe(false)
    expect(gmailMessageDetailSchema.safeParse({ ...detail, attachments: -1 }).success).toBe(false)
    expect(gmailMessageDetailSchema.safeParse({ ...detail, attachments: 1.5 }).success).toBe(false)
  })

  it('bounds the body to 50 000 characters and the links to 50', () => {
    expect(gmailMessageDetailSchema.safeParse({ ...detail, body: 'x'.repeat(50_000) }).success).toBe(true)
    expect(gmailMessageDetailSchema.safeParse({ ...detail, body: 'x'.repeat(50_001) }).success).toBe(false)
    const link = (n: number) => ({ text: `l${n}`, url: `https://example.com/${n}` })
    expect(gmailMessageDetailSchema.safeParse({ ...detail, links: Array.from({ length: 50 }, (_, n) => link(n)) }).success).toBe(true)
    expect(gmailMessageDetailSchema.safeParse({ ...detail, links: Array.from({ length: 51 }, (_, n) => link(n)) }).success).toBe(false)
  })

  it('caps link text at 200 characters', () => {
    expect(gmailMessageDetailSchema.safeParse({ ...detail, links: [{ text: 'a'.repeat(200), url: 'https://example.com' }] }).success).toBe(true)
    expect(gmailMessageDetailSchema.safeParse({ ...detail, links: [{ text: 'a'.repeat(201), url: 'https://example.com' }] }).success).toBe(false)
  })

  it('bounds link urls to 2048 characters and sender and subject to 1000', () => {
    expect(GMAIL_URL_MAX).toBe(2048)
    expect(GMAIL_HEADER_MAX).toBe(1000)
    const url = (length: number) => `https://example.com/${'a'.repeat(length - 'https://example.com/'.length)}`
    expect(gmailMessageDetailSchema.safeParse({ ...detail, links: [{ text: 'a', url: url(2048) }] }).success).toBe(true)
    expect(gmailMessageDetailSchema.safeParse({ ...detail, links: [{ text: 'a', url: url(2049) }] }).success).toBe(false)
    for (const key of ['from', 'fromAddress', 'subject'] as const) {
      expect(gmailMessageDetailSchema.safeParse({ ...detail, [key]: 'x'.repeat(1000) }).success, key).toBe(true)
      expect(gmailMessageDetailSchema.safeParse({ ...detail, [key]: 'x'.repeat(1001) }).success, key).toBe(false)
    }
  })

  it('only carries http and https links', () => {
    for (const url of ['http://example.com', 'HTTPS://example.com/a'])
      expect(gmailMessageDetailSchema.safeParse({ ...detail, links: [{ text: 'a', url }] }).success, url).toBe(true)
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'mailto:a@example.com', 'file:///c:/x'])
      expect(gmailMessageDetailSchema.safeParse({ ...detail, links: [{ text: 'a', url }] }).success, url).toBe(false)
  })
})

describe('gmail new mail', () => {
  it('has optional sender and subject', () => {
    expect(gmailNewMailSchema.parse({ count: 1, id: 'm1' })).toEqual({ count: 1, id: 'm1' })
    const full = { count: 3, id: 'm1', from: 'Ana', subject: 'Hola' }
    expect(gmailNewMailSchema.parse(full)).toEqual(full)
    expect(gmailNewMailSchema.safeParse({ count: 0, id: 'm1' }).success).toBe(false)
    expect(gmailNewMailSchema.safeParse({ count: 1, id: '' }).success).toBe(false)
    expect(gmailNewMailSchema.safeParse({ count: 1, id: 'm1', snippet: 'x' }).success).toBe(false)
  })
})

describe('gmail action inputs', () => {
  it('id input takes a 1-64 character id only', () => {
    expect(gmailIdInputSchema.parse({ id: 'm1' })).toEqual({ id: 'm1' })
    expect(gmailIdInputSchema.safeParse({ id: 'x'.repeat(64) }).success).toBe(true)
    expect(gmailIdInputSchema.safeParse({ id: 'x'.repeat(65) }).success).toBe(false)
    expect(gmailIdInputSchema.safeParse({ id: '' }).success).toBe(false)
    expect(gmailIdInputSchema.safeParse({}).success).toBe(false)
    expect(gmailIdInputSchema.safeParse({ id: 'm1', url: 'x' }).success).toBe(false)
  })

  it('open-link input takes an id and an integer index 0-49', () => {
    for (const index of [0, 49]) expect(gmailOpenLinkInputSchema.safeParse({ id: 'm1', index }).success, String(index)).toBe(true)
    for (const index of [-1, 50, 1.5, '1']) expect(gmailOpenLinkInputSchema.safeParse({ id: 'm1', index }).success, String(index)).toBe(false)
    expect(gmailOpenLinkInputSchema.safeParse({ id: '', index: 0 }).success).toBe(false)
    expect(gmailOpenLinkInputSchema.safeParse({ id: 'm1', index: 0, url: 'https://example.com' }).success).toBe(false)
  })
})

describe('messageFullSchema', () => {
  const full = {
    id: 'm1',
    threadId: 't1',
    snippet: 's',
    labelIds: ['INBOX', 'UNREAD'],
    internalDate: '1731319200000',
    historyId: '9',
    payload: {
      mimeType: 'multipart/mixed',
      filename: '',
      headers: [{ name: 'From', value: 'Ana <ana@example.com>' }],
      body: { size: 0 },
      parts: [
        {
          mimeType: 'multipart/alternative',
          headers: [],
          body: { size: 0 },
          parts: [{ partId: '0.0', mimeType: 'text/plain', filename: '', headers: [], body: { data: 'aG9sYQ', size: 4 } }],
        },
        { mimeType: 'application/pdf', filename: 'a.pdf', headers: [], body: { attachmentId: 'att', size: 10 } },
      ],
    },
  }

  it('parses nested parts and tolerates extra fields', () => {
    const parsed = messageFullSchema.parse(full)
    expect(parsed.payload.parts?.[0]?.parts?.[0]?.body.data).toBe('aG9sYQ')
    expect(parsed.payload.parts?.[1]?.filename).toBe('a.pdf')
  })

  it('rejects a payload without a mime type or body', () => {
    expect(messageFullSchema.safeParse({ ...full, payload: { ...full.payload, mimeType: undefined } }).success).toBe(false)
    expect(messageFullSchema.safeParse({ ...full, payload: { ...full.payload, body: undefined } }).success).toBe(false)
    expect(messageFullSchema.safeParse({ ...full, payload: { ...full.payload, parts: [{ mimeType: 'text/plain' }] } }).success).toBe(false)
  })
})
