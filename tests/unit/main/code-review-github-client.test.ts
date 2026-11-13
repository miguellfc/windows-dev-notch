import { describe, expect, it, vi } from 'vitest'
import {
  CodeReviewError,
  toReviewItem,
  type CodeReviewErrorCode,
  type CodeReviewFetch,
} from '../../../src/main/code-review/client-common'
import { GITHUB_API_BASE, createGithubClient } from '../../../src/main/code-review/github-client'
import { itemSchema } from '../../../src/shared/code-review/schema'

const TOKEN = 'ghp_test_token'
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers })

interface PrOptions {
  id?: string
  number?: number
  isDraft?: boolean
  reviewDecision?: string | null
  totalCount?: number
  latest?: string | null
  mergeable?: string
  rollup?: string | null
  author?: { login: string } | null
  noCommits?: boolean
  /** Explicit review nodes (oldest first); otherwise built from `latest` by `bob`. */
  reviewNodes?: { state: string; author: { login: string } | null }[]
  /** `reviews: null` (connection not available). */
  nullReviews?: boolean
}

const reviewsOf = (o: PrOptions) => {
  const nodes = o.reviewNodes ?? (o.latest ? [{ state: o.latest, author: { login: 'bob' } }] : [])
  return { totalCount: o.totalCount ?? nodes.length, nodes }
}

const pr = (o: PrOptions = {}) => ({
  id: o.id ?? 'PR_1',
  number: o.number ?? 1,
  title: 'Add feature',
  url: `https://github.com/owner/repo/pull/${o.number ?? 1}`,
  isDraft: o.isDraft ?? false,
  updatedAt: '2026-11-12T10:00:00Z',
  reviewDecision: o.reviewDecision ?? null,
  mergeable: o.mergeable ?? 'MERGEABLE',
  repository: { nameWithOwner: 'owner/repo' },
  author: o.author === undefined ? { login: 'octocat' } : o.author,
  reviews: o.nullReviews ? null : reviewsOf(o),
  commits: { nodes: o.noCommits ? [] : [{ commit: { statusCheckRollup: o.rollup === undefined || o.rollup === null ? null : { state: o.rollup } } }] },
})

const data = (toReview: unknown[], mine: unknown[], counts: { mine?: number; unreviewed?: number | null } = {}) => ({
  data: {
    viewer: { login: 'octocat' },
    toReview: { issueCount: toReview.length, nodes: toReview },
    mine: { issueCount: counts.mine ?? mine.length, nodes: mine },
    unreviewed: counts.unreviewed === null ? null : { issueCount: counts.unreviewed ?? 0 },
  },
})

const setup = (respond: (body: { query: string; variables?: Record<string, unknown> }) => Response | Promise<Response>) => {
  const fetchMock = vi.fn<CodeReviewFetch>(async (_url, init) => respond(JSON.parse(String(init?.body))))
  const client = createGithubClient({ fetch: fetchMock, token: TOKEN })
  return { client, fetchMock }
}

const expectCode = async (promise: Promise<unknown>, code: CodeReviewErrorCode) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(CodeReviewError)
  expect((error as CodeReviewError).code).toBe(code)
  // Never carries the token.
  expect(String((error as Error).message)).not.toContain(TOKEN)
}

describe('github client: request', () => {
  it('posts one GraphQL query with both searches, the bearer token and no redirects', async () => {
    const { client, fetchMock } = setup(() => json(data([], [])))
    await client.fetch()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${GITHUB_API_BASE}/graphql`)
    expect(GITHUB_API_BASE).toBe('https://api.github.com')
    expect(init?.method).toBe('POST')
    expect(init?.redirect).toBe('manual')
    const headers = init?.headers as Record<string, string>
    expect(headers['authorization']).toBe(`Bearer ${TOKEN}`)
    const body = String(init?.body)
    expect(body).toContain('is:open is:pr review-requested:@me archived:false')
    expect(body).toContain('is:open is:pr author:@me archived:false')
    expect(body).toContain('is:open is:pr author:@me archived:false draft:false review:none')
    const parsed = JSON.parse(body) as { query: string; variables: Record<string, unknown> }
    expect(parsed.query).toContain('viewer')
    expect(parsed.query).toContain('search(type: ISSUE')
    expect(parsed.variables['first']).toBe(20)
    expect(parsed.query).toMatch(/unreviewed: search\(type: ISSUE, first: 0, query: \$unreviewed\) \{ issueCount \}/)
    expect(parsed.query).toMatch(/mine: search\([^)]*\) \{ issueCount nodes/)
    expect(parsed.query).toMatch(/reviews\(last: 20, states: \[[^\]]+\]\) \{ totalCount nodes \{ state author \{ login \} \} \}/)
  })

  it('uses a custom api base when given', async () => {
    const fetchMock = vi.fn<CodeReviewFetch>(async () => json(data([], [])))
    await createGithubClient({ fetch: fetchMock, token: TOKEN, apiBase: 'http://127.0.0.1:4100' }).fetch()
    expect(fetchMock.mock.calls[0]![0]).toBe('http://127.0.0.1:4100/graphql')
  })

  it('viewer() returns the login', async () => {
    const { client, fetchMock } = setup(() => json({ data: { viewer: { login: 'octocat' } } }))
    await expect(client.viewer()).resolves.toBe('octocat')
    const init = fetchMock.mock.calls[0]![1]
    expect((init?.headers as Record<string, string>)['authorization']).toBe(`Bearer ${TOKEN}`)
  })
})

describe('github client: mapping', () => {
  it('maps a PR to an item with ref, author, url and flags', async () => {
    const { client } = setup(() => json(data([pr({ id: 'PR_r', number: 7, rollup: 'SUCCESS', mergeable: 'CONFLICTING' })], [])))
    const result = await client.fetch()
    expect(result.toReview).toEqual([
      {
        id: 'PR_r',
        ref: 'owner/repo#7',
        title: 'Add feature',
        author: 'octocat',
        updatedAt: '2026-11-12T10:00:00Z',
        draft: false,
        review: 'none',
        checks: 'pass',
        conflicts: true,
        url: 'https://github.com/owner/repo/pull/7',
      },
    ])
    expect(result.mine).toEqual([])
  })

  it('maps checks from the status rollup', async () => {
    const cases: [string | null, 'pass' | 'fail' | 'running' | null][] = [
      ['SUCCESS', 'pass'],
      ['FAILURE', 'fail'],
      ['ERROR', 'fail'],
      ['PENDING', 'running'],
      ['EXPECTED', 'running'],
      [null, null],
    ]
    for (const [rollup, checks] of cases) {
      const { client } = setup(() => json(data([pr({ rollup })], [])))
      expect((await client.fetch()).toReview[0]!.checks, String(rollup)).toBe(checks)
    }
    const { client } = setup(() => json(data([pr({ noCommits: true })], [])))
    expect((await client.fetch()).toReview[0]!.checks).toBeNull()
  })

  it('maps the review state from the decision and the latest review', async () => {
    const cases: [PrOptions, string][] = [
      [{ totalCount: 0 }, 'none'],
      [{ totalCount: 1, reviewDecision: 'APPROVED', latest: 'COMMENTED' }, 'approved'],
      [{ totalCount: 1, reviewDecision: 'CHANGES_REQUESTED', latest: 'COMMENTED' }, 'changes'],
      [{ totalCount: 1, reviewDecision: null, latest: 'APPROVED' }, 'approved'],
      [{ totalCount: 2, reviewDecision: 'REVIEW_REQUIRED', latest: 'CHANGES_REQUESTED' }, 'changes'],
      [{ totalCount: 1, reviewDecision: 'REVIEW_REQUIRED', latest: 'COMMENTED' }, 'commented'],
      [{ totalCount: 1, reviewDecision: null, latest: 'DISMISSED' }, 'commented'],
    ]
    for (const [options, review] of cases) {
      const { client } = setup(() => json(data([], [pr(options)])))
      expect((await client.fetch()).mine[0]!.review, JSON.stringify(options)).toBe(review)
    }
  })

  it('counts own open non-draft PRs without reviews and reports their review state', async () => {
    const mine = [
      pr({ id: 'a', totalCount: 0 }),
      pr({ id: 'b', totalCount: 0, isDraft: true }),
      pr({ id: 'c', totalCount: 1, latest: 'COMMENTED' }),
      pr({ id: 'd', totalCount: 0 }),
    ]
    const { client } = setup(() => json(data([], mine)))
    const result = await client.fetch()
    expect(result.unreviewed).toBe(2)
    expect(result.ownReview).toEqual([
      { id: 'a', review: 'none' },
      { id: 'c', review: 'commented' },
      { id: 'd', review: 'none' },
    ])
    expect(result.mine.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(result.mine[1]!.draft).toBe(true)
  })

  it('keeps at most 20 items per list', async () => {
    const many = Array.from({ length: 25 }, (_, i) => pr({ id: `PR_${i}`, number: i }))
    const { client } = setup(() => json(data(many, many)))
    const result = await client.fetch()
    expect(result.toReview).toHaveLength(20)
    expect(result.mine).toHaveLength(20)
    expect(result.unreviewed).toBe(20)
  })

  it('skips null and non-PR search nodes and tolerates a deleted author', async () => {
    const { client } = setup(() => json(data([null, {}, pr({ author: null })], [])))
    const result = await client.fetch()
    expect(result.toReview).toHaveLength(1)
    expect(result.toReview[0]!.author).toBe('')
  })

  it('cuts very long titles', async () => {
    const long = { ...pr(), title: 'x'.repeat(5000) }
    const { client } = setup(() => json(data([long], [])))
    expect((await client.fetch()).toReview[0]!.title).toHaveLength(1000)
  })
})

describe('github client: unreviewed count beyond the list', () => {
  it('uses the list when it holds every own PR, even if the search disagrees', async () => {
    const { client } = setup(() => json(data([], [pr({ id: 'a' }), pr({ id: 'b', latest: 'APPROVED' })], { unreviewed: 0 })))
    expect((await client.fetch()).unreviewed).toBe(1)
  })

  it('uses the review:none search count when the list is cut at 20', async () => {
    const many = Array.from({ length: 20 }, (_, i) => pr({ id: `PR_${i}`, latest: i < 15 ? 'APPROVED' : null }))
    const { client } = setup(() => json(data([], many, { mine: 40, unreviewed: 27 })))
    expect((await client.fetch()).unreviewed).toBe(27)
  })

  it('never reports fewer than the list shows, and caps at 100', async () => {
    const many = Array.from({ length: 20 }, (_, i) => pr({ id: `PR_${i}` }))
    expect((await setup(() => json(data([], many, { mine: 40, unreviewed: 3 }))).client.fetch()).unreviewed).toBe(20)
    expect((await setup(() => json(data([], many, { mine: 400, unreviewed: 350 }))).client.fetch()).unreviewed).toBe(100)
    expect((await setup(() => json(data([], many, { mine: 40, unreviewed: null }))).client.fetch()).unreviewed).toBe(20)
  })
})

describe('github client: tolerant reviews', () => {
  it('treats a null reviews connection as no review without failing', async () => {
    const { client } = setup(() => json(data([], [pr({ id: 'a', nullReviews: true })])))
    const result = await client.fetch()
    expect(result.mine[0]!.review).toBe('none')
    expect(result.unreviewed).toBe(1)
  })

  it("ignores the PR author's own reviews (self-review never counts nor alerts)", async () => {
    const self = { state: 'COMMENTED', author: { login: 'octocat' } }
    const { client } = setup(() =>
      json(
        data([], [
          pr({ id: 'a', reviewNodes: [self] }),
          pr({ id: 'b', reviewNodes: [{ state: 'APPROVED', author: { login: 'bob' } }, self] }),
          pr({ id: 'c', reviewNodes: [{ state: 'COMMENTED', author: null }] }),
        ]),
      ),
    )
    const result = await client.fetch()
    expect(result.ownReview).toEqual([
      { id: 'a', review: 'none' },
      { id: 'b', review: 'approved' },
      { id: 'c', review: 'commented' },
    ])
    expect(result.unreviewed).toBe(1)
  })
})

describe('github client: errors', () => {
  it('uses the data of a 200 response that also has errors', async () => {
    const { client } = setup(() => json({ ...data([pr()], []), errors: [{ message: 'Some repo not accessible' }] }))
    const result = await client.fetch()
    expect(result.toReview).toHaveLength(1)
  })

  it('gives invalid-response for errors without data', async () => {
    const { client } = setup(() => json({ errors: [{ message: 'Bad query' }] }))
    await expectCode(client.fetch(), 'invalid-response')
  })

  it('gives rate-limited for a RATE_LIMITED GraphQL error without data', async () => {
    const { client } = setup(() => json({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'limit' }] }))
    await expectCode(client.fetch(), 'rate-limited')
  })

  it('gives invalid-response for a malformed body or schema', async () => {
    await expectCode(setup(() => new Response('not json', { status: 200 })).client.fetch(), 'invalid-response')
    await expectCode(setup(() => json({ data: { viewer: { login: 1 } } })).client.viewer(), 'invalid-response')
    const bad = { ...pr(), isDraft: 'no' }
    await expectCode(setup(() => json(data([bad], []))).client.fetch(), 'invalid-response')
  })

  it('maps HTTP statuses to codes', async () => {
    const cases: [number, CodeReviewErrorCode, Record<string, string>?][] = [
      [401, 'auth'],
      [403, 'auth'],
      [403, 'rate-limited', { 'x-ratelimit-remaining': '0' }],
      [403, 'rate-limited', { 'retry-after': '60' }],
      [429, 'rate-limited'],
      [500, 'server'],
      [502, 'server'],
      [404, 'invalid-response'],
      [301, 'invalid-response', { location: 'https://evil.example/graphql' }],
    ]
    for (const [status, code, headers] of cases) {
      await expectCode(setup(() => json({}, status, headers)).client.fetch(), code)
    }
  })

  it('treats an opaque redirect as invalid-response', async () => {
    const opaque = { type: 'opaqueredirect', status: 0, ok: false, headers: new Headers() } as unknown as Response
    await expectCode(setup(() => opaque).client.fetch(), 'invalid-response')
  })

  it('gives network when fetch rejects', async () => {
    await expectCode(
      setup(() => {
        throw new TypeError('fetch failed')
      }).client.fetch(),
      'network',
    )
  })
})

describe('toReviewItem', () => {
  it('drops the url so the item fits the strict IPC schema', async () => {
    const { client } = setup(() => json(data([pr()], [])))
    const [first] = (await client.fetch()).toReview
    const item = toReviewItem(first!)
    expect(itemSchema.parse(item)).toEqual(item)
    expect(item).not.toHaveProperty('url')
  })
})
