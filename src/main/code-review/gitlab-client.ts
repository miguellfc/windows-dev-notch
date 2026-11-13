import { z } from 'zod'
import { classifyGitlabEvent, dayStart, localDate, monthRange, summarize, weekStart, ZERO_TOTALS } from '../../shared/code-review/contributions'
import {
  CODE_REVIEW_LIST_LIMIT,
  normalizeGitlabUrl,
  type Checks,
  type ContributionSummary,
  type ContributionTotals,
  type ReviewState,
} from '../../shared/code-review/schema'
import {
  CodeReviewError,
  clip,
  mapPool,
  readJson,
  sendOk,
  sendRaw,
  snapshot,
  statusError,
  type ClientItem,
  type CodeReviewClient,
  type CodeReviewFetch,
} from './client-common'

// GitLab responses: not strict, and most fields optional (they vary across GitLab versions).
const userSchema = z.object({ id: z.int().positive(), username: z.string() })
type GitlabUser = z.infer<typeof userSchema>

const mrSchema = z.object({
  iid: z.int().positive(),
  project_id: z.int().positive(),
  title: z.string(),
  web_url: z.string(),
  updated_at: z.string(),
  references: z.object({ full: z.string() }).nullable().optional(),
  author: z.object({ username: z.string() }).nullable().optional(),
  draft: z.boolean().nullable().optional(),
  work_in_progress: z.boolean().nullable().optional(),
  has_conflicts: z.boolean().nullable().optional(),
  detailed_merge_status: z.string().nullable().optional(),
  head_pipeline: z.object({ status: z.string() }).nullable().optional(),
})
type GitlabMr = z.infer<typeof mrSchema>

const mrListSchema = z.array(mrSchema)

const userRefSchema = z.object({ id: z.int().optional() }).loose().nullable().optional()

/** `GET …/approvals`: `{ approved_by: [{ user: {...} }] }`. */
const approvalsSchema = z.object({ approved_by: z.array(z.object({ user: userRefSchema }).loose()).nullable().optional() })

/** `GET …/reviewers` (GitLab 15.9+): `[{ user: {...}, state: 'unreviewed' | 'reviewed' | 'requested_changes' | 'approved' | …, created_at }]`. */
const reviewersSchema = z.array(z.object({ user: userRefSchema, state: z.string().nullable().optional() }).loose())

/** `GET /users/:id/events`: only the fields the classification reads (titles are never read). */
const eventSchema = z.object({
  action_name: z.string(),
  created_at: z.string(),
  target_type: z.string().nullable().optional(),
  push_data: z.object({ commit_count: z.int().min(0).nullable().optional() }).loose().nullable().optional(),
  note: z.object({ noteable_type: z.string().nullable().optional() }).loose().nullable().optional(),
})
const eventListSchema = z.array(eventSchema)

/** Events per page and the most pages read per query (beyond it the summary is `partial`). */
export const GITLAB_EVENTS_PER_PAGE = 100
export const GITLAB_EVENTS_MAX_PAGES = 10

const RUNNING = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled', 'waiting_for_callback'])

const checksOf = (mr: GitlabMr): Checks => {
  const status = mr.head_pipeline?.status
  if (status === 'success') return 'pass'
  if (status === 'failed') return 'fail'
  if (status !== undefined && RUNNING.has(status)) return 'running'
  return null
}

/** What others did on an own MR: approvals (by anyone but the user) and reviewer states. */
interface OwnReview {
  approved: boolean
  states: ReadonlyArray<string | null | undefined>
}

/** Approvals win; then any `requested_changes` → changes, any `reviewed` → commented. */
const reviewOf = ({ approved, states }: OwnReview): ReviewState => {
  if (approved || states.includes('approved')) return 'approved'
  if (states.includes('requested_changes')) return 'changes'
  if (states.includes('reviewed')) return 'commented'
  return 'none'
}

const NO_REVIEW: OwnReview = { approved: false, states: [] }

/** At most this many per-MR requests (`/approvals`, `/reviewers`) are in flight at once. */
export const GITLAB_PER_MR_CONCURRENCY = 6

/**
 * Outcome of a per-MR request: `missing` for a lasting "no data" (404, or 403 from an edition or
 * permission quirk), `failed` for a passing failure (5xx, 429, network, bad body).
 */
type PerMr<T> = { kind: 'ok'; data: T } | { kind: 'missing' } | { kind: 'failed' }

const isDraft = (mr: GitlabMr): boolean => mr.draft === true || mr.work_in_progress === true

const toItem = (mr: GitlabMr, review: OwnReview): ClientItem => ({
  id: `${mr.project_id}!${mr.iid}`,
  ref: clip(mr.references?.full ?? `!${mr.iid}`),
  title: clip(mr.title),
  author: clip(mr.author?.username ?? ''),
  updatedAt: clip(mr.updated_at, 64),
  draft: isDraft(mr),
  review: reviewOf(review),
  checks: checksOf(mr),
  conflicts: mr.has_conflicts === true || mr.detailed_merge_status === 'conflict',
  url: mr.web_url,
})

export interface GitlabClientOptions {
  fetch: CodeReviewFetch
  /** Normalized server URL (origin + base path, no trailing `/`; https only). */
  baseUrl: string
  token: string
  /** Dev/E2E only: also accept `http://127.0.0.1:<port>` (a fake local server). */
  allowLoopbackHttp?: boolean
}

const isLoopbackHttp = (baseUrl: string): boolean => /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(baseUrl)

/**
 * GitLab REST client (`/api/v4`): 3 + 2N requests per refresh (N = own non-draft MRs), every
 * response validated with zod. Refuses a base URL that is not normalized https.
 */
export function createGitlabClient({ fetch: doFetch, baseUrl, token, allowLoopbackHttp = false }: GitlabClientOptions): CodeReviewClient {
  if (normalizeGitlabUrl(baseUrl) !== baseUrl && !(allowLoopbackHttp && isLoopbackHttp(baseUrl))) {
    throw new Error('GitLab base URL must be a normalized https URL')
  }
  const init: RequestInit = { headers: { 'private-token': token, accept: 'application/json' } }

  const url = (path: string, query: Record<string, string> = {}): string => {
    const target = new URL(`${baseUrl}/api/v4/${path}`)
    for (const [name, value] of Object.entries(query)) target.searchParams.set(name, value)
    return target.toString()
  }

  const get = async <S extends z.ZodType>(path: string, schema: S, query?: Record<string, string>): Promise<z.output<S>> =>
    readJson(await sendOk(doFetch, url(path, query), init), schema)

  /** A per-MR request never fails the whole fetch, except a 401 (the token is no longer valid). */
  const getPerMr = async <S extends z.ZodType>(path: string, schema: S): Promise<PerMr<z.output<S>>> => {
    let response: Response
    try {
      response = await sendRaw(doFetch, url(path), init)
    } catch {
      return { kind: 'failed' }
    }
    if (response.status === 401) throw new CodeReviewError('auth')
    if (response.status === 404 || (response.status === 403 && statusError(response).code === 'auth')) return { kind: 'missing' }
    if (!response.ok) return { kind: 'failed' }
    try {
      return { kind: 'ok', data: await readJson(response, schema) }
    } catch {
      return { kind: 'failed' }
    }
  }

  const user = () => get('user', userSchema)

  const list = async (query: Record<string, string>) =>
    (await get('merge_requests', mrListSchema, { state: 'opened', ...query, per_page: String(CODE_REVIEW_LIST_LIMIT) })).slice(
      0,
      CODE_REVIEW_LIST_LIMIT,
    )

  const others = <T extends { user?: { id?: number | undefined } | null | undefined }>(entries: readonly T[], me: GitlabUser): T[] =>
    entries.filter((entry) => entry.user?.id !== me.id)

  return {
    async viewer() {
      return (await user()).username
    },

    async fetch() {
      const me = await user()
      const [toReview, mine] = await Promise.all([
        list({ reviewer_id: String(me.id), scope: 'all' }),
        list({ scope: 'created_by_me' }),
      ])
      // Drafts are never "unreviewed" nor alerted: no per-MR calls for them.
      const open = mine.filter((mr) => !isDraft(mr))
      const base = (mr: GitlabMr) => `projects/${mr.project_id}/merge_requests/${mr.iid}`
      const [approvals, reviewers] = await Promise.all([
        mapPool(open, GITLAB_PER_MR_CONCURRENCY / 2, (mr) => getPerMr(`${base(mr)}/approvals`, approvalsSchema)),
        mapPool(open, GITLAB_PER_MR_CONCURRENCY / 2, (mr) => getPerMr(`${base(mr)}/reviewers`, reviewersSchema)),
      ])
      // The user's own approval or review never counts. A passing failure degrades to what the other
      // call says and leaves the MR out of `ownReview` this round, so it cannot fake a first review.
      const uncertain = new Set<string>()
      const reviews = new Map<GitlabMr, OwnReview>()
      open.forEach((mr, i) => {
        const a = approvals[i] ?? { kind: 'failed' }
        const r = reviewers[i] ?? { kind: 'failed' }
        if (a.kind === 'failed' || r.kind === 'failed') uncertain.add(`${mr.project_id}!${mr.iid}`)
        reviews.set(mr, {
          approved: a.kind === 'ok' && others(a.data.approved_by ?? [], me).length > 0,
          states: r.kind === 'ok' ? others(r.data, me).map((entry) => entry.state) : [],
        })
      })
      return snapshot(
        toReview.map((mr) => toItem(mr, NO_REVIEW)),
        mine.map((mr) => toItem(mr, reviews.get(mr) ?? NO_REVIEW)),
        uncertain,
      )
    },

    async contributions(now: Date): Promise<ContributionSummary> {
      const me = await user()
      const monthFrom = monthRange(now).from
      const week = weekStart(now)
      const today = dayStart(now)
      // The week may start in the previous month: read from the earlier of both starts.
      const start = week < monthFrom ? week : monthFrom
      const monthKey = localDate(monthFrom)
      const weekKey = localDate(week)
      const todayKey = localDate(today)
      // `after`/`before` are exclusive dates applied in the SERVER's time zone (created_at >
      // after.end_of_day and < before.beginning_of_day; UTC on gitlab.com). Two extra days on each side
      // cover any local offset; events are then filtered by their local date.
      const query = {
        after: localDate(new Date(start.getFullYear(), start.getMonth(), start.getDate() - 2)),
        before: localDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2)),
        per_page: String(GITLAB_EVENTS_PER_PAGE),
      }

      const counts = new Map<string, number>()
      const totals = { today: { ...ZERO_TOTALS }, week: { ...ZERO_TOTALS }, month: { ...ZERO_TOTALS } }
      let partial = false
      // Pages in series (newest first), until a short page, an empty X-Next-Page or the page limit.
      for (let page = 1; ; page++) {
        const response = await sendOk(doFetch, url(`users/${me.id}/events`, { ...query, page: String(page) }), init)
        const next = response.headers.get('x-next-page')
        const events = await readJson(response, eventListSchema)
        for (const event of events) {
          const created = new Date(event.created_at)
          if (Number.isNaN(created.getTime())) continue
          const day = localDate(created)
          if (day > todayKey || (day < monthKey && day < weekKey)) continue
          const kind = classifyGitlabEvent(event)
          const add = (t: ContributionTotals) => {
            t.commits += kind.commits
            if (kind.opened) t.opened++
            if (kind.merged) t.merged++
            if (kind.review) t.reviews++
          }
          if (day >= monthKey) {
            add(totals.month)
            if (kind.contribution) counts.set(day, (counts.get(day) ?? 0) + 1)
          }
          if (day >= weekKey) add(totals.week)
          if (day === todayKey) add(totals.today)
        }
        const more = events.length >= GITLAB_EVENTS_PER_PAGE && next !== ''
        if (!more) break
        if (page === GITLAB_EVENTS_MAX_PAGES) {
          partial = true
          break
        }
      }
      return summarize({ now, counts, today: totals.today, week: totals.week, monthTotals: totals.month, partial, restricted: false })
    },
  }
}
