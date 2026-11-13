import { z } from 'zod'
import {
  CODE_REVIEW_COUNT_CAP,
  CODE_REVIEW_ID_MAX,
  CODE_REVIEW_LIST_LIMIT,
  type Checks,
  type ReviewState,
} from '../../shared/code-review/schema'
import {
  CodeReviewError,
  clip,
  readJson,
  sendOk,
  snapshot,
  type ClientItem,
  type CodeReviewClient,
  type CodeReviewFetch,
} from './client-common'

/** Production GitHub API origin (GraphQL lives at `/graphql`). */
export const GITHUB_API_BASE = 'https://api.github.com'

export const GITHUB_TO_REVIEW_QUERY = 'is:open is:pr review-requested:@me archived:false'
export const GITHUB_MINE_QUERY = 'is:open is:pr author:@me archived:false'
/** Only its `issueCount` is read: the unreviewed count when `mine` is cut at the list limit. */
export const GITHUB_UNREVIEWED_QUERY = 'is:open is:pr author:@me archived:false draft:false review:none'

/** Submitted reviews only (a pending review of the viewer is not a review yet). */
const REVIEW_STATES = '[APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED]'

/** Last reviews read per PR to find one not written by the PR's author. */
const REVIEWS_READ = 20

export const GITHUB_QUERY = `query CodeReview($toReview: String!, $mine: String!, $unreviewed: String!, $first: Int!) {
  viewer { login }
  toReview: search(type: ISSUE, first: $first, query: $toReview) { nodes { ...pr } }
  mine: search(type: ISSUE, first: $first, query: $mine) { issueCount nodes { ...pr } }
  unreviewed: search(type: ISSUE, first: 0, query: $unreviewed) { issueCount }
}
fragment pr on PullRequest {
  id
  number
  title
  url
  isDraft
  updatedAt
  reviewDecision
  mergeable
  repository { nameWithOwner }
  author { login }
  reviews(last: ${REVIEWS_READ}, states: ${REVIEW_STATES}) { totalCount nodes { state author { login } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`

const VIEWER_QUERY = 'query Viewer { viewer { login } }'

// GitHub responses: not strict, GitHub adds fields.
const viewerSchema = z.object({ login: z.string() })

const prSchema = z.object({
  id: z.string().min(1).max(CODE_REVIEW_ID_MAX),
  number: z.int(),
  title: z.string(),
  url: z.string(),
  isDraft: z.boolean(),
  updatedAt: z.string(),
  reviewDecision: z.string().nullable().optional(),
  mergeable: z.string().nullable().optional(),
  repository: z.object({ nameWithOwner: z.string() }),
  author: z.object({ login: z.string() }).nullable().optional(),
  reviews: z
    .object({
      nodes: z.array(z.object({ state: z.string(), author: z.object({ login: z.string() }).nullable().optional() }).nullable()).optional(),
    })
    .nullable()
    .optional(),
  commits: z
    .object({
      nodes: z.array(
        z.object({ commit: z.object({ statusCheckRollup: z.object({ state: z.string() }).nullable().optional() }) }).nullable(),
      ),
    })
    .optional(),
})
type GithubPr = z.infer<typeof prSchema>

/** Search results may contain `null` or `{}` (non-PR nodes); real PRs are validated afterwards. */
const searchSchema = z.object({
  issueCount: z.int().min(0).optional(),
  nodes: z.array(z.record(z.string(), z.unknown()).nullable()),
})

const graphqlErrorsSchema = z.array(z.object({ type: z.string().optional() }).loose()).optional()

const fetchResponseSchema = z.object({
  data: z
    .object({
      viewer: viewerSchema,
      toReview: searchSchema,
      mine: searchSchema,
      unreviewed: z.object({ issueCount: z.int().min(0) }).nullable().optional(),
    })
    .nullable()
    .optional(),
  errors: graphqlErrorsSchema,
})

const viewerResponseSchema = z.object({
  data: z.object({ viewer: viewerSchema }).nullable().optional(),
  errors: graphqlErrorsSchema,
})

/**
 * Only reviews by someone other than the PR's author count (a self-review never marks a PR
 * reviewed nor alerts). None → `none`; then the review decision; then the latest such review.
 */
const reviewOf = (pr: GithubPr): ReviewState => {
  const author = pr.author?.login
  const others = (pr.reviews?.nodes ?? []).filter((r) => r !== null && (author === undefined || r.author?.login !== author))
  if (others.length === 0) return 'none'
  if (pr.reviewDecision === 'APPROVED') return 'approved'
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes'
  const latest = others.at(-1)?.state
  if (latest === 'APPROVED') return 'approved'
  if (latest === 'CHANGES_REQUESTED') return 'changes'
  return 'commented'
}

const checksOf = (pr: GithubPr): Checks => {
  const state = pr.commits?.nodes.at(-1)?.commit.statusCheckRollup?.state
  if (state === 'SUCCESS') return 'pass'
  if (state === 'FAILURE' || state === 'ERROR') return 'fail'
  if (state === 'PENDING' || state === 'EXPECTED') return 'running'
  return null
}

const toItem = (pr: GithubPr): ClientItem => ({
  id: pr.id,
  ref: clip(`${pr.repository.nameWithOwner}#${pr.number}`),
  title: clip(pr.title),
  author: clip(pr.author?.login ?? ''),
  updatedAt: clip(pr.updatedAt, 64),
  draft: pr.isDraft,
  review: reviewOf(pr),
  checks: checksOf(pr),
  conflicts: pr.mergeable === 'CONFLICTING',
  url: pr.url,
})

/** Keeps PR nodes (skips `null` and `{}` from non-PR results); a malformed PR is `invalid-response`. */
const itemsOf = (nodes: ReadonlyArray<Record<string, unknown> | null>): ClientItem[] => {
  const items: ClientItem[] = []
  for (const node of nodes) {
    if (node === null || !('id' in node)) continue
    const parsed = prSchema.safeParse(node)
    if (!parsed.success) throw new CodeReviewError('invalid-response')
    items.push(toItem(parsed.data))
    if (items.length === CODE_REVIEW_LIST_LIMIT) break
  }
  return items
}

/** GraphQL errors without data: a rate limit is `rate-limited`, anything else `invalid-response`. */
const noDataError = (errors: ReadonlyArray<{ type?: string | undefined }> | undefined): CodeReviewError =>
  new CodeReviewError(errors?.some((e) => e.type === 'RATE_LIMITED') ? 'rate-limited' : 'invalid-response')

export interface GithubClientOptions {
  fetch: CodeReviewFetch
  token: string
  /** API origin (`https://api.github.com`; a fake server in E2E). */
  apiBase?: string
}

/** GitHub GraphQL client: one query per refresh, every response validated with zod. */
export function createGithubClient({ fetch: doFetch, token, apiBase = GITHUB_API_BASE }: GithubClientOptions): CodeReviewClient {
  const post = async (query: string, variables?: Record<string, unknown>): Promise<Response> =>
    sendOk(doFetch, `${apiBase}/graphql`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(variables === undefined ? { query } : { query, variables }),
    })

  return {
    async viewer() {
      const body = await readJson(await post(VIEWER_QUERY), viewerResponseSchema)
      if (!body.data) throw noDataError(body.errors)
      return body.data.viewer.login
    },

    async fetch() {
      const response = await post(GITHUB_QUERY, {
        toReview: GITHUB_TO_REVIEW_QUERY,
        mine: GITHUB_MINE_QUERY,
        unreviewed: GITHUB_UNREVIEWED_QUERY,
        first: CODE_REVIEW_LIST_LIMIT,
      })
      // A 200 with `errors` and `data` (e.g. one inaccessible repository) still uses the data.
      const body = await readJson(response, fetchResponseSchema)
      if (!body.data) throw noDataError(body.errors)
      const { toReview, mine, unreviewed } = body.data
      const result = snapshot(itemsOf(toReview.nodes), itemsOf(mine.nodes))
      // The list rule (no review by anyone but the author) is exact while the list holds every own PR.
      // Beyond the limit, `review:none` counts the rest; it also treats self-reviews as reviews, so it
      // can only undercount — never report fewer than the list itself shows.
      const listComplete = (mine.issueCount ?? 0) <= result.mine.length
      if (!listComplete && unreviewed) result.unreviewed = Math.max(result.unreviewed, unreviewed.issueCount)
      result.unreviewed = Math.min(result.unreviewed, CODE_REVIEW_COUNT_CAP)
      return result
    },
  }
}
