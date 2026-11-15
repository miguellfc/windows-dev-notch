import type { z } from 'zod'
import {
  CODE_REVIEW_LIST_LIMIT,
  CODE_REVIEW_TEXT_MAX,
  type ContributionSummary,
  type ReviewItem,
  type ReviewState,
} from '../../shared/code-review/schema'

export type CodeReviewFetch = (url: string, init?: RequestInit) => Promise<Response>

export type CodeReviewErrorCode = 'auth' | 'network' | 'rate-limited' | 'server' | 'invalid-response'

/** Failure of a GitHub/GitLab API call. Carries only a code, never tokens, titles or repositories. */
export class CodeReviewError extends Error {
  readonly code: CodeReviewErrorCode

  constructor(code: CodeReviewErrorCode) {
    super(`Code review API failed: ${code}`)
    this.name = 'CodeReviewError'
    this.code = code
  }
}

/** An item plus the URL main opens in the browser (the URL never goes to the renderer). */
export interface ClientItem extends ReviewItem {
  url: string
}

export interface CodeReviewSnapshot {
  /** PR/MRs that wait for the user's review (at most CODE_REVIEW_LIST_LIMIT). */
  toReview: ClientItem[]
  /** The user's open PR/MRs (at most CODE_REVIEW_LIST_LIMIT). */
  mine: ClientItem[]
  /** Own open, non-draft PR/MRs without any review. */
  unreviewed: number
  /** Review state of each own open, non-draft PR/MR (what the first-review detector observes). */
  ownReview: { id: string; review: ReviewState }[]
}

export interface CodeReviewClient {
  /** Login (GitHub) or username (GitLab) of the token's account. */
  viewer(): Promise<string>
  fetch(): Promise<CodeReviewSnapshot>
  /** The current month's contributions (local time of `now`): chart plus today / week / month totals. */
  contributions(now: Date): Promise<ContributionSummary>
}

/** Drops the URL: what may cross IPC to the notch. */
export const toReviewItem = (item: ClientItem): ReviewItem => ({
  id: item.id,
  ref: item.ref,
  title: item.title,
  author: item.author,
  updatedAt: item.updatedAt,
  draft: item.draft,
  review: item.review,
  checks: item.checks,
  conflicts: item.conflicts,
})

/** A request that hangs must not block the next tick forever. */
export const REQUEST_TIMEOUT_MS = 30_000

export const clip = (text: string, max = CODE_REVIEW_TEXT_MAX): string => (text.length > max ? text.slice(0, max) : text)

const isRedirect = (response: Response): boolean =>
  response.type === 'opaqueredirect' || response.status === 0 || (response.status >= 300 && response.status < 400)

/** Maps a non-OK status to a code. 401/403 are `auth` unless the 403 is a rate limit. */
export const statusError = (response: Response): CodeReviewError => {
  const { status } = response
  if (isRedirect(response)) return new CodeReviewError('invalid-response')
  if (status === 429) return new CodeReviewError('rate-limited')
  if (status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'))) {
    return new CodeReviewError('rate-limited')
  }
  if (status === 401 || status === 403) return new CodeReviewError('auth')
  if (status >= 500) return new CodeReviewError('server')
  return new CodeReviewError('invalid-response')
}

/**
 * Sends one request that never follows a redirect (`redirect: 'manual'`, any 3xx is refused), so a
 * token never leaves the origin it was meant for. Network failures become `network`.
 */
export const send = async (
  doFetch: CodeReviewFetch,
  url: string,
  init: RequestInit,
  options: { allowNotFound?: boolean } = {},
): Promise<Response | null> => {
  const response = await sendRaw(doFetch, url, init)
  if (options.allowNotFound && response.status === 404) return null
  if (isRedirect(response) || !response.ok) throw statusError(response)
  return response
}

/** One request, never following a redirect (a 3xx is `invalid-response`); the status is left to the caller. */
export const sendRaw = async (doFetch: CodeReviewFetch, url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    response = await doFetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch {
    throw new CodeReviewError('network')
  }
  if (isRedirect(response)) throw new CodeReviewError('invalid-response')
  return response
}

/** Maps `items` with at most `limit` calls of `fn` in flight, keeping order; stops starting new calls after a failure. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  let failed = false
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++
      try {
        results[index] = await fn(items[index] as T)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** Like `send`, for requests where a 404 is an error too. */
export const sendOk = async (doFetch: CodeReviewFetch, url: string, init: RequestInit): Promise<Response> => {
  const response = await send(doFetch, url, init)
  if (response === null) throw new CodeReviewError('invalid-response') // unreachable without allowNotFound
  return response
}

/** Reads and validates a JSON body; anything else is `invalid-response`. */
export const readJson = async <S extends z.ZodType>(response: Response, schema: S): Promise<z.output<S>> => {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new CodeReviewError('invalid-response')
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new CodeReviewError('invalid-response')
  return parsed.data
}

/** Builds the snapshot from the mapped lists: limits, unreviewed count and own review states. */
export const snapshot = (
  toReview: ClientItem[],
  mine: ClientItem[],
  /** Own items whose review state is uncertain this round (a per-item call failed): left out of `ownReview`. */
  uncertain: ReadonlySet<string> = new Set(),
): CodeReviewSnapshot => {
  const own = mine.slice(0, CODE_REVIEW_LIST_LIMIT)
  const open = own.filter((item) => !item.draft)
  return {
    toReview: toReview.slice(0, CODE_REVIEW_LIST_LIMIT),
    mine: own,
    unreviewed: open.filter(({ review }) => review === 'none').length,
    ownReview: open.filter(({ id }) => !uncertain.has(id)).map(({ id, review }) => ({ id, review })),
  }
}
