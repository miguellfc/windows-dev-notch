import { describe, expect, it } from 'vitest'
import {
  GMAIL_RECENT_LIMIT,
  GMAIL_UNREAD_CAP,
  gmailMessageSchema,
  gmailOpenInputSchema,
  gmailStateSchema,
  gmailStatusSchema,
  messageListSchema,
  messageMetadataSchema,
  parseClientFile,
  profileSchema,
  tokenResponseSchema,
} from '../../../src/shared/gmail/schema'

const state = { status: 'ok', account: 'a@b.c', unread: 3, updatedAt: '2026-11-11T10:00:00.000Z', persistent: true }

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
