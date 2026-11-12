import type { z } from 'zod'
import { decodeSnippet, displaySender } from '../../shared/gmail/headers'
import {
  GMAIL_RECENT_LIMIT,
  GMAIL_UNREAD_CAP,
  messageListSchema,
  messageMetadataSchema,
  profileSchema,
  type GmailMessage,
} from '../../shared/gmail/schema'
import type { GmailFetch } from './gmail-auth'

/** Production Gmail API origin (paths live under `/gmail/v1/users/me/`). */
export const GMAIL_API_BASE = 'https://gmail.googleapis.com'

const PRIMARY = 'in:inbox category:primary'
const UNREAD_QUERY = `${PRIMARY} is:unread`
/** A request that hangs must not block the next tick forever. */
const REQUEST_TIMEOUT_MS = 30_000

export type GmailApiErrorCode = 'unauthorized' | 'network' | 'rate-limited' | 'server' | 'invalid-response'

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
  /** Unread messages in Primary, capped at GMAIL_UNREAD_CAP. */
  unreadCount(): Promise<number>
  /** The most recent messages in Primary (at most GMAIL_RECENT_LIMIT), newest first. */
  recent(): Promise<GmailMessage[]>
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

/** Read-only Gmail REST client: plain `fetch`, every response validated with zod. */
export function createGmailClient({ fetch: doFetch, apiBase, getAccessToken, onUnauthorized }: GmailClientOptions): GmailClient {
  const send = async (url: string): Promise<Response> => {
    const token = await getAccessToken()
    try {
      return await doFetch(url, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch {
      throw new GmailApiError('network')
    }
  }

  const get = async <S extends z.ZodType>(path: string, query: Query, schema: S): Promise<z.output<S>> => {
    const result = await getOrMissing(path, query, schema)
    if (result === null) throw statusError(404)
    return result
  }

  /** Like get, but a 404 (e.g. a message deleted after the list) resolves to null. */
  const getOrMissing = async <S extends z.ZodType>(path: string, query: Query, schema: S): Promise<z.output<S> | null> => {
    const url = new URL(`${apiBase}/gmail/v1/users/me/${path}`)
    for (const [name, value] of query) url.searchParams.append(name, value)

    let response = await send(url.toString())
    if (response.status === 401) {
      // One refresh, one retry: a second 401 (or a refused refresh) ends the session.
      if (!(await onUnauthorized())) throw new GmailApiError('unauthorized')
      response = await send(url.toString())
    }
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

  return {
    async profile() {
      return (await get('profile', [], profileSchema)).emailAddress
    },

    async unreadCount() {
      return Math.min((await list(UNREAD_QUERY, GMAIL_UNREAD_CAP)).length, GMAIL_UNREAD_CAP)
    },

    async recent() {
      const ids = (await list(PRIMARY, GMAIL_RECENT_LIMIT)).slice(0, GMAIL_RECENT_LIMIT)
      // Promise.all keeps the list order whatever order the metadata arrives in.
      const found = await Promise.all(
        ids.map(async ({ id }) => {
          const meta = await getOrMissing(
            `messages/${encodeURIComponent(id)}`,
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
        }),
      )
      return found.filter((m): m is GmailMessage => m !== null)
    },
  }
}
