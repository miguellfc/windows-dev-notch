import type { z } from 'zod'
import { clip, decodeSnippet, displaySender, senderAddress } from '../../shared/gmail/headers'
import {
  GMAIL_HEADER_MAX,
  GMAIL_RECENT_LIMIT,
  GMAIL_UNREAD_CAP,
  gmailMessageDetailSchema,
  messageFullSchema,
  messageListSchema,
  messageMetadataSchema,
  profileSchema,
  type GmailMessage,
  type GmailMessageDetail,
} from '../../shared/gmail/schema'
import type { GmailFetch } from './gmail-auth'
import { extractMessage } from './message-text'

/** Production Gmail API origin (paths live under `/gmail/v1/users/me/`). */
export const GMAIL_API_BASE = 'https://gmail.googleapis.com'

const PRIMARY = 'in:inbox category:primary'
const UNREAD_QUERY = `${PRIMARY} is:unread`
/** A request that hangs must not block the next tick forever. */
const REQUEST_TIMEOUT_MS = 30_000

export type GmailApiErrorCode = 'unauthorized' | 'network' | 'rate-limited' | 'server' | 'invalid-response' | 'not-found'

/** Failure of a Gmail API call. Carries only a code, never tokens or message data. */
export class GmailApiError extends Error {
  readonly code: GmailApiErrorCode

  constructor(code: GmailApiErrorCode) {
    super(`Gmail API failed: ${code}`)
    this.name = 'GmailApiError'
    this.code = code
  }
}

export interface GmailClientOptions {
  fetch: GmailFetch
  /** Origin of the Gmail API (`https://gmail.googleapis.com`; a fake server in E2E). */
  apiBase: string
  getAccessToken: () => Promise<string>
  /** Called once on a 401; resolves true when a new access token is available. */
  onUnauthorized: () => Promise<boolean>
}

export interface GmailClient {
  /** Address of the signed-in account. */
  profile(): Promise<string>
  /** Ids of the unread messages in Primary, newest first, at most GMAIL_UNREAD_CAP (the count is its length). */
  unreadIds(): Promise<string[]>
  /** The most recent messages in Primary (at most GMAIL_RECENT_LIMIT), newest first. */
  recent(): Promise<GmailMessage[]>
  /** One message as a list row (metadata only); `null` when it no longer exists. */
  summary(id: string): Promise<GmailMessage | null>
  /** One message as plain text (`format=full`); a missing message is `not-found`. */
  message(id: string): Promise<GmailMessageDetail>
  /** Removes the UNREAD label; a message that no longer exists counts as done. */
  markRead(id: string): Promise<void>
  /** Deletes the message permanently (no trash); a message that no longer exists counts as done. */
  remove(id: string): Promise<void>
}

type Query = ReadonlyArray<readonly [string, string]>

const statusError = (status: number): GmailApiError => {
  if (status === 401) return new GmailApiError('unauthorized')
  // Gmail reports per-user rate limits as 403 (userRateLimitExceeded / rateLimitExceeded).
  if (status === 429 || status === 403) return new GmailApiError('rate-limited')
  if (status >= 500) return new GmailApiError('server')
  return new GmailApiError('invalid-response')
}

const header = (headers: ReadonlyArray<{ name: string; value: string }>, name: string): string | undefined =>
  headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value

const isoDate = (dateHeader: string | undefined, internalDate: string): string => {
  const fromHeader = dateHeader ? new Date(dateHeader) : null
  if (fromHeader && !Number.isNaN(fromHeader.getTime())) return fromHeader.toISOString()
  const millis = /^\d+$/.test(internalDate) ? Number(internalDate) : Number.NaN
  const fromInternal = new Date(millis)
  if (Number.isNaN(fromInternal.getTime())) throw new GmailApiError('invalid-response')
  return fromInternal.toISOString()
}

interface Write {
  method: 'POST' | 'DELETE'
  /** JSON body (POST only). */
  json?: unknown
}

const messagePath = (id: string) => `messages/${encodeURIComponent(id)}`

/** Gmail REST client: plain `fetch`, every response validated with zod. */
export function createGmailClient({ fetch: doFetch, apiBase, getAccessToken, onUnauthorized }: GmailClientOptions): GmailClient {
  const send = async (url: string, write?: Write): Promise<Response> => {
    const token = await getAccessToken()
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' }
    const init: RequestInit = { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
    if (write) {
      init.method = write.method
      if (write.json !== undefined) {
        headers['content-type'] = 'application/json'
        init.body = JSON.stringify(write.json)
      }
    }
    try {
      return await doFetch(url, init)
    } catch {
      throw new GmailApiError('network')
    }
  }

  /** Sends once; on a 401, one refresh and one retry (a second 401 or a refused refresh ends the session). */
  const request = async (path: string, query: Query, write?: Write): Promise<Response> => {
    const url = new URL(`${apiBase}/gmail/v1/users/me/${path}`)
    for (const [name, value] of query) url.searchParams.append(name, value)
    let response = await send(url.toString(), write)
    if (response.status === 401) {
      if (!(await onUnauthorized())) throw new GmailApiError('unauthorized')
      response = await send(url.toString(), write)
    }
    return response
  }

  /** A write whose target is gone (404) is already done. */
  const writeTo = async (path: string, write: Write): Promise<void> => {
    const response = await request(path, [], write)
    if (response.status === 404) return
    if (!response.ok) throw statusError(response.status)
  }

  const get = async <S extends z.ZodType>(path: string, query: Query, schema: S): Promise<z.output<S>> => {
    const result = await getOrMissing(path, query, schema)
    if (result === null) throw statusError(404)
    return result
  }

  /** Like get, but a 404 (e.g. a message deleted after the list) resolves to null. */
  const getOrMissing = async <S extends z.ZodType>(path: string, query: Query, schema: S): Promise<z.output<S> | null> => {
    const response = await request(path, query)
    if (response.status === 404) return null
    if (!response.ok) throw statusError(response.status)

    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new GmailApiError('invalid-response')
    }
    const parsed = schema.safeParse(body)
    if (!parsed.success) throw new GmailApiError('invalid-response')
    return parsed.data
  }

  const list = async (q: string, maxResults: number) =>
    (await get('messages', [['q', q], ['maxResults', String(maxResults)]], messageListSchema)).messages ?? []

  const summary = async (id: string): Promise<GmailMessage | null> => {
    const meta = await getOrMissing(
      messagePath(id),
      [
        ['format', 'metadata'],
        ['metadataHeaders', 'From'],
        ['metadataHeaders', 'Subject'],
        ['metadataHeaders', 'Date'],
      ],
      messageMetadataSchema,
    )
    if (meta === null) return null // deleted between the list and its metadata
    const headers = meta.payload.headers
    return {
      id: meta.id,
      threadId: meta.threadId,
      from: displaySender(header(headers, 'From')),
      subject: header(headers, 'Subject') ?? '',
      snippet: decodeSnippet(meta.snippet),
      date: isoDate(header(headers, 'Date'), meta.internalDate),
      unread: meta.labelIds?.includes('UNREAD') ?? false,
    }
  }

  return {
    async profile() {
      return (await get('profile', [], profileSchema)).emailAddress
    },

    async unreadIds() {
      return (await list(UNREAD_QUERY, GMAIL_UNREAD_CAP)).slice(0, GMAIL_UNREAD_CAP).map(({ id }) => id)
    },

    async recent() {
      const ids = (await list(PRIMARY, GMAIL_RECENT_LIMIT)).slice(0, GMAIL_RECENT_LIMIT)
      // Promise.all keeps the list order whatever order the metadata arrives in.
      const found = await Promise.all(ids.map(({ id }) => summary(id)))
      return found.filter((m): m is GmailMessage => m !== null)
    },

    summary,

    async message(id) {
      const full = await getOrMissing(messagePath(id), [['format', 'full']], messageFullSchema)
      if (full === null) throw new GmailApiError('not-found')
      const headers = full.payload.headers
      let extracted: ReturnType<typeof extractMessage>
      try {
        extracted = extractMessage(full.payload)
      } catch {
        // A mail the extractor cannot read is a clean error for the reader, never a crash.
        throw new GmailApiError('invalid-response')
      }
      const from = header(headers, 'From')
      // Headers are cut to the schema's bound: an odd long header never makes a mail unreadable.
      const parsed = gmailMessageDetailSchema.safeParse({
        id: full.id,
        threadId: full.threadId,
        from: clip(displaySender(from), GMAIL_HEADER_MAX),
        fromAddress: clip(senderAddress(from), GMAIL_HEADER_MAX),
        subject: clip(header(headers, 'Subject') ?? '', GMAIL_HEADER_MAX),
        date: isoDate(header(headers, 'Date'), full.internalDate),
        unread: full.labelIds?.includes('UNREAD') ?? false,
        ...extracted,
      })
      if (!parsed.success) throw new GmailApiError('invalid-response')
      return parsed.data
    },

    async markRead(id) {
      await writeTo(`${messagePath(id)}/modify`, { method: 'POST', json: { removeLabelIds: ['UNREAD'] } })
    },

    async remove(id) {
      await writeTo(messagePath(id), { method: 'DELETE' })
    },
  }
}
