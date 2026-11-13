import { describe, expect, it, vi } from 'vitest'
import { CodeReviewError, type CodeReviewErrorCode, type CodeReviewFetch } from '../../../src/main/code-review/client-common'
import { createGitlabClient } from '../../../src/main/code-review/gitlab-client'
import { contributionSummarySchema } from '../../../src/shared/code-review/schema'

const BASE = 'https://gitlab.x.com/base'
const TOKEN = 'glpat-test-token'
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers })

interface MrOptions {
  projectId?: number
  iid?: number
  draft?: boolean
  workInProgress?: boolean
  hasConflicts?: boolean
  detailedMergeStatus?: string
  pipeline?: string | null
  noReferences?: boolean
}

const mr = (o: MrOptions = {}) => {
  const projectId = o.projectId ?? 10
  const iid = o.iid ?? 1
  const out: Record<string, unknown> = {
    id: projectId * 1000 + iid,
    iid,
    project_id: projectId,
    title: 'Improve thing',
    web_url: `https://gitlab.x.com/base/group/project/-/merge_requests/${iid}`,
    author: { id: 7, username: 'alice', name: 'Alice' },
    updated_at: '2026-11-12T10:00:00Z',
    has_conflicts: o.hasConflicts ?? false,
  }
  if (!o.noReferences) out['references'] = { short: `!${iid}`, full: `group/project!${iid}` }
  if (o.draft !== undefined) out['draft'] = o.draft
  if (o.workInProgress !== undefined) out['work_in_progress'] = o.workInProgress
  if (o.detailedMergeStatus !== undefined) out['detailed_merge_status'] = o.detailedMergeStatus
  // The list endpoint carries reviewers as plain users (no review state).
  out['reviewers'] = [{ id: 9, username: 'bob', name: 'Bob', state: 'active' }]
  if (o.pipeline !== undefined) out['head_pipeline'] = o.pipeline === null ? null : { id: 1, status: o.pipeline }
  return out
}

interface Server {
  user?: unknown
  toReview?: unknown[]
  mine?: unknown[]
  /** approvals by `${projectId}/${iid}`; missing = no approvals. */
  approvals?: Record<string, unknown[]>
  /** `/reviewers` answers by `${projectId}/${iid}`; missing = []. */
  reviewers?: Record<string, unknown[]>
  status?: (url: URL) => Response | undefined
}

const setup = (server: Server = {}) => {
  const fetchMock = vi.fn<CodeReviewFetch>(async (raw) => {
    const url = new URL(raw)
    const override = server.status?.(url)
    if (override) return override
    const path = url.pathname
    if (path === '/base/api/v4/user') return json(server.user ?? { id: 42, username: 'me' })
    if (path === '/base/api/v4/merge_requests') {
      return json(url.searchParams.get('scope') === 'created_by_me' ? (server.mine ?? []) : (server.toReview ?? []))
    }
    const m = /^\/base\/api\/v4\/projects\/(\d+)\/merge_requests\/(\d+)\/approvals$/.exec(path)
    if (m) {
      const approvedBy = (server.approvals ?? {})[`${m[1]}/${m[2]}`] ?? []
      return json({ id: 1, iid: Number(m[2]), approved: true, approvals_required: 0, approved_by: approvedBy })
    }
    const r = /^\/base\/api\/v4\/projects\/(\d+)\/merge_requests\/(\d+)\/reviewers$/.exec(path)
    if (r) return json((server.reviewers ?? {})[`${r[1]}/${r[2]}`] ?? [])
    return json({ message: 'not found' }, 404)
  })
  const client = createGitlabClient({ fetch: fetchMock, baseUrl: BASE, token: TOKEN })
  return { client, fetchMock }
}

const expectCode = async (promise: Promise<unknown>, code: CodeReviewErrorCode) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(CodeReviewError)
  expect((error as CodeReviewError).code).toBe(code)
  expect(String((error as Error).message)).not.toContain(TOKEN)
}

const user = (id: number, username: string) => ({
  id,
  username,
  name: username,
  state: 'active',
  avatar_url: null,
  web_url: `https://gitlab.x.com/${username}`,
})
const approver = { user: user(9, 'bob') }
const reviewer = (state: string, id = 9, username = 'bob') => ({ user: user(id, username), state, created_at: '2026-11-12T09:00:00Z' })

describe('gitlab client: requests', () => {
  it('viewer() returns the username using PRIVATE-TOKEN and never following redirects', async () => {
    const { client, fetchMock } = setup()
    await expect(client.viewer()).resolves.toBe('me')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE}/api/v4/user`)
    expect((init?.headers as Record<string, string>)['private-token']).toBe(TOKEN)
    expect(init?.redirect).toBe('manual')
  })

  it('asks for the user, both lists and the approvals and reviewers of each own MR, all with the token and no redirects', async () => {
    const { client, fetchMock } = setup({ toReview: [mr({ iid: 5 })], mine: [mr({ iid: 1 }), mr({ projectId: 11, iid: 2 })] })
    await client.fetch()
    const urls = fetchMock.mock.calls.map(([u]) => new URL(u))
    const lists = urls.filter((u) => u.pathname === '/base/api/v4/merge_requests')
    expect(lists).toHaveLength(2)
    const toReview = lists.find((u) => u.searchParams.get('scope') === 'all')!
    expect(Object.fromEntries(toReview.searchParams)).toEqual({ state: 'opened', reviewer_id: '42', scope: 'all', per_page: '20' })
    const mine = lists.find((u) => u.searchParams.get('scope') === 'created_by_me')!
    expect(Object.fromEntries(mine.searchParams)).toEqual({ state: 'opened', scope: 'created_by_me', per_page: '20' })
    expect(urls.map((u) => u.pathname)).toEqual(
      expect.arrayContaining([
        '/base/api/v4/user',
        '/base/api/v4/projects/10/merge_requests/1/approvals',
        '/base/api/v4/projects/10/merge_requests/1/reviewers',
        '/base/api/v4/projects/11/merge_requests/2/approvals',
        '/base/api/v4/projects/11/merge_requests/2/reviewers',
      ]),
    )
    expect(fetchMock).toHaveBeenCalledTimes(7)
    for (const [u, init] of fetchMock.mock.calls) {
      expect(u.startsWith(`${BASE}/api/v4/`)).toBe(true)
      expect(init?.redirect).toBe('manual')
      expect((init?.headers as Record<string, string>)['private-token']).toBe(TOKEN)
    }
  })

  it('never follows a redirect: any 3xx is invalid-response and only one request is made', async () => {
    const { client, fetchMock } = setup({
      status: () => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }),
    })
    await expectCode(client.viewer(), 'invalid-response')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const opaque = { type: 'opaqueredirect', status: 0, ok: false, headers: new Headers() } as unknown as Response
    await expectCode(setup({ status: () => opaque }).client.fetch(), 'invalid-response')
  })
})

describe('gitlab client: mapping', () => {
  it('maps an MR to an item', async () => {
    const { client } = setup({ toReview: [mr({ iid: 5, pipeline: 'success', hasConflicts: true })] })
    const result = await client.fetch()
    expect(result.toReview).toEqual([
      {
        id: '10!5',
        ref: 'group/project!5',
        title: 'Improve thing',
        author: 'alice',
        updatedAt: '2026-11-12T10:00:00Z',
        draft: false,
        review: 'none',
        checks: 'pass',
        conflicts: true,
        url: 'https://gitlab.x.com/base/group/project/-/merge_requests/5',
      },
    ])
  })

  it('tolerates missing optional fields', async () => {
    const minimal = { id: 1, iid: 3, project_id: 4, title: 't', web_url: 'https://gitlab.x.com/base/g/p/-/merge_requests/3', updated_at: '2026-11-12T10:00:00Z' }
    const { client } = setup({ toReview: [minimal], mine: [{ ...minimal, author: null }] })
    const result = await client.fetch()
    expect(result.toReview[0]).toMatchObject({ id: '4!3', ref: '!3', author: '', draft: false, checks: null, conflicts: false, review: 'none' })
    expect(result.mine[0]!.author).toBe('')
  })

  it('reads drafts from draft or work_in_progress and conflicts from the detailed status', async () => {
    const { client } = setup({
      toReview: [mr({ iid: 1, draft: true }), mr({ iid: 2, workInProgress: true }), mr({ iid: 3, detailedMergeStatus: 'conflict' })],
    })
    const [a, b, c] = (await client.fetch()).toReview
    expect(a!.draft).toBe(true)
    expect(b!.draft).toBe(true)
    expect(c!.conflicts).toBe(true)
  })

  it('maps the pipeline status to checks', async () => {
    const cases: [string | null, 'pass' | 'fail' | 'running' | null][] = [
      ['success', 'pass'],
      ['failed', 'fail'],
      ['running', 'running'],
      ['pending', 'running'],
      ['created', 'running'],
      ['canceled', null],
      ['skipped', null],
      [null, null],
    ]
    for (const [pipeline, checks] of cases) {
      const { client } = setup({ toReview: [mr({ pipeline })] })
      expect((await client.fetch()).toReview[0]!.checks, String(pipeline)).toBe(checks)
    }
  })

  it('takes the review from approvals alone when nobody has a reviewer state', async () => {
    const { client } = setup({
      mine: [mr({ iid: 1 }), mr({ iid: 2 })],
      approvals: { '10/1': [approver] },
      reviewers: { '10/2': [reviewer('unreviewed')] },
    })
    const result = await client.fetch()
    expect(result.mine.map((i) => i.review)).toEqual(['approved', 'none'])
    expect(result.unreviewed).toBe(1)
  })

  it('ignores the plain reviewer users of the list payload', async () => {
    const { client } = setup({ mine: [mr({ iid: 1 })] })
    expect((await client.fetch()).mine[0]!.review).toBe('none')
  })

  it('combines the /reviewers states with approvals (approved wins)', async () => {
    const { client } = setup({
      mine: [mr({ iid: 1 }), mr({ iid: 2 }), mr({ iid: 3 }), mr({ iid: 4 }), mr({ iid: 5 }), mr({ iid: 6 })],
      reviewers: {
        '10/1': [reviewer('reviewed')],
        '10/2': [reviewer('requested_changes')],
        '10/3': [reviewer('requested_changes')],
        '10/4': [reviewer('unreviewed'), reviewer('review_started', 8, 'eve')],
        '10/5': [reviewer('reviewed'), reviewer('requested_changes', 8, 'eve')],
        '10/6': [reviewer('approved')],
      },
      approvals: { '10/3': [approver] },
    })
    const result = await client.fetch()
    expect(result.mine.map((i) => i.review)).toEqual(['commented', 'changes', 'approved', 'none', 'changes', 'approved'])
    expect(result.unreviewed).toBe(1)
  })

  it("ignores the user's own approval and review of their MR", async () => {
    const { client } = setup({
      mine: [mr({ iid: 1 })],
      approvals: { '10/1': [{ user: user(42, 'me') }] },
      reviewers: { '10/1': [reviewer('reviewed', 42, 'me')] },
    })
    const result = await client.fetch()
    expect(result.mine[0]!.review).toBe('none')
    expect(result.unreviewed).toBe(1)
  })

  it('makes no per-MR calls for the MRs to review nor for own drafts', async () => {
    const { client, fetchMock } = setup({ toReview: [mr({ iid: 1 })], mine: [mr({ iid: 2, draft: true })] })
    const result = await client.fetch()
    expect(result.toReview[0]!.review).toBe('none')
    expect(result.mine[0]!.review).toBe('none')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('counts own open non-draft MRs without reviews and reports their review state', async () => {
    const { client } = setup({
      mine: [mr({ iid: 1 }), mr({ iid: 2, draft: true }), mr({ iid: 3 })],
      approvals: { '10/3': [approver] },
    })
    const result = await client.fetch()
    expect(result.unreviewed).toBe(1)
    expect(result.ownReview).toEqual([
      { id: '10!1', review: 'none' },
      { id: '10!3', review: 'approved' },
    ])
  })

  it('keeps at most 20 items per list and asks approvals and reviewers only for those', async () => {
    const many = Array.from({ length: 25 }, (_, i) => mr({ iid: i + 1 }))
    const { client, fetchMock } = setup({ toReview: many, mine: many })
    const result = await client.fetch()
    expect(result.toReview).toHaveLength(20)
    expect(result.mine).toHaveLength(20)
    expect(result.unreviewed).toBe(20)
    expect(fetchMock.mock.calls.filter(([u]) => u.includes('/approvals'))).toHaveLength(20)
    expect(fetchMock.mock.calls.filter(([u]) => u.includes('/reviewers'))).toHaveLength(20)
  })

  it('treats missing approvals or reviewers endpoints (404) as no review', async () => {
    const { client } = setup({
      mine: [mr({ iid: 1 })],
      status: (url) => (/\/(approvals|reviewers)$/.test(url.pathname) ? json({ message: '404 Not found' }, 404) : undefined),
    })
    const result = await client.fetch()
    expect(result.mine[0]!.review).toBe('none')
  })
})

describe('gitlab client: errors', () => {
  it('maps HTTP statuses to codes', async () => {
    const cases: [number, CodeReviewErrorCode][] = [
      [401, 'auth'],
      [403, 'auth'],
      [429, 'rate-limited'],
      [500, 'server'],
      [503, 'server'],
      [404, 'invalid-response'],
    ]
    for (const [status, code] of cases) {
      await expectCode(setup({ status: () => json({ message: 'x' }, status) }).client.fetch(), code)
    }
  })

  it('fails the whole fetch when a list call fails or a per-MR call says 401', async () => {
    await expectCode(
      setup({ status: (u) => (u.searchParams.get('scope') === 'all' ? json({}, 500) : undefined) }).client.fetch(),
      'server',
    )
    await expectCode(
      setup({ mine: [mr()], status: (u) => (u.pathname.endsWith('/approvals') ? json({}, 401) : undefined) }).client.fetch(),
      'auth',
    )
    await expectCode(
      setup({ mine: [mr()], status: (u) => (u.pathname.endsWith('/reviewers') ? json({}, 401) : undefined) }).client.fetch(),
      'auth',
    )
    await expectCode(
      setup({ mine: [mr()], status: (u) => (u.searchParams.get('scope') === 'created_by_me' ? json({}, 403) : undefined) }).client.fetch(),
      'auth',
    )
  })

  it('gives invalid-response for a malformed body or schema', async () => {
    await expectCode(setup({ status: () => new Response('<html>', { status: 200 }) }).client.viewer(), 'invalid-response')
    await expectCode(setup({ user: { id: 'x', username: 'me' } }).client.viewer(), 'invalid-response')
    await expectCode(setup({ toReview: [{ ...mr(), iid: 'one' }] }).client.fetch(), 'invalid-response')
    await expectCode(setup({ mine: { not: 'a list' } as unknown as unknown[] }).client.fetch(), 'invalid-response')
  })

  it('gives network when fetch rejects', async () => {
    const fetchMock = vi.fn<CodeReviewFetch>(async () => {
      throw new TypeError('fetch failed')
    })
    await expectCode(createGitlabClient({ fetch: fetchMock, baseUrl: BASE, token: TOKEN }).fetch(), 'network')
  })
})

describe('gitlab client: base URL', () => {
  const fetchMock = vi.fn<CodeReviewFetch>()

  it('refuses a base URL that is not normalized https', () => {
    for (const baseUrl of ['http://gitlab.x.com', 'https://gitlab.x.com/', 'https://u@gitlab.x.com', 'https://gitlab.x.com?a=1', 'nope', '']) {
      expect(() => createGitlabClient({ fetch: fetchMock, baseUrl, token: TOKEN }), baseUrl).toThrow()
    }
    expect(() => createGitlabClient({ fetch: fetchMock, baseUrl: 'https://gitlab.x.com/base', token: TOKEN })).not.toThrow()
  })

  it('accepts a loopback http server only when explicitly allowed (E2E)', () => {
    expect(() => createGitlabClient({ fetch: fetchMock, baseUrl: 'http://127.0.0.1:4100', token: TOKEN })).toThrow()
    expect(() =>
      createGitlabClient({ fetch: fetchMock, baseUrl: 'http://127.0.0.1:4100', token: TOKEN, allowLoopbackHttp: true }),
    ).not.toThrow()
    expect(() =>
      createGitlabClient({ fetch: fetchMock, baseUrl: 'http://evil.example:80', token: TOKEN, allowLoopbackHttp: true }),
    ).toThrow()
  })
})

describe('gitlab client: per-MR failures degrade', () => {
  const two = { mine: [mr({ iid: 1 }), mr({ iid: 2 })], approvals: { '10/1': [approver] }, reviewers: { '10/2': [reviewer('requested_changes')] } }
  const failing = (suffix: string, response: () => Response) => (u: URL) => (u.pathname.endsWith(suffix) ? response() : undefined)

  it('a 403 on /reviewers means no reviewer data: approvals only, still observed', async () => {
    const result = await setup({ ...two, status: failing('/reviewers', () => json({ message: '403 Forbidden' }, 403)) }).client.fetch()
    expect(result.mine.map((i) => i.review)).toEqual(['approved', 'none'])
    expect(result.ownReview).toEqual([
      { id: '10!1', review: 'approved' },
      { id: '10!2', review: 'none' },
    ])
  })

  it('a 403 on /approvals means no approvals: reviewer states only, still observed', async () => {
    const result = await setup({ ...two, status: failing('/approvals', () => json({ message: '403 Forbidden' }, 403)) }).client.fetch()
    expect(result.mine.map((i) => i.review)).toEqual(['none', 'changes'])
    expect(result.ownReview).toHaveLength(2)
  })

  it('a passing /reviewers failure degrades to approvals and leaves the MRs out of ownReview', async () => {
    const cases: [string, () => Response][] = [
      ['500', () => json({}, 500)],
      ['429', () => json({}, 429)],
      ['malformed', () => json({ not: 'a list' })],
      ['network', () => {
        throw new TypeError('fetch failed')
      }],
    ]
    for (const [name, response] of cases) {
      const result = await setup({ ...two, status: failing('/reviewers', response) }).client.fetch()
      expect(result.mine.map((i) => i.review), name).toEqual(['approved', 'none'])
      expect(result.unreviewed, name).toBe(1)
      expect(result.ownReview, name).toEqual([])
    }
  })

  it('a passing /approvals failure degrades to reviewer states and leaves the MRs out of ownReview', async () => {
    const result = await setup({ ...two, status: failing('/approvals', () => json({}, 503)) }).client.fetch()
    expect(result.mine.map((i) => i.review)).toEqual(['none', 'changes'])
    expect(result.ownReview).toEqual([])
  })

  it('only the MR whose call failed is left out', async () => {
    const result = await setup({
      ...two,
      status: (u) => (u.pathname === '/base/api/v4/projects/10/merge_requests/2/reviewers' ? json({}, 500) : undefined),
    }).client.fetch()
    expect(result.ownReview).toEqual([{ id: '10!1', review: 'approved' }])
  })
})

describe('gitlab client: per-MR concurrency', () => {
  it('keeps at most 6 per-MR requests in flight', async () => {
    let inFlight = 0
    let peak = 0
    const fetchMock = vi.fn<CodeReviewFetch>(async (raw) => {
      const url = new URL(raw)
      if (url.pathname.endsWith('/user')) return json({ id: 42, username: 'me' })
      if (url.pathname.endsWith('/merge_requests')) {
        return json(url.searchParams.get('scope') === 'created_by_me' ? Array.from({ length: 20 }, (_, i) => mr({ iid: i + 1 })) : [])
      }
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 2))
      inFlight--
      return json(url.pathname.endsWith('/approvals') ? { approved_by: [] } : [])
    })
    const result = await createGitlabClient({ fetch: fetchMock, baseUrl: BASE, token: TOKEN }).fetch()
    expect(result.unreviewed).toBe(20)
    expect(fetchMock).toHaveBeenCalledTimes(43)
    expect(peak).toBeLessThanOrEqual(6)
    expect(peak).toBeGreaterThan(1)
  })
})

describe('gitlab client: contributions', () => {
  // Friday 13 Nov 2026, 10:30 in Europe/Madrid (tests/unit/setup-tz.ts), CET = UTC+1.
  const NOW = new Date(2026, 10, 13, 10, 30)
  const EVENTS = '/base/api/v4/users/42/events'

  const event = (created_at: string, action_name: string, extra: Record<string, unknown> = {}) => ({
    id: 1,
    project_id: 10,
    action_name,
    target_type: null,
    target_title: 'Secret title',
    author: { id: 42, username: 'me' },
    created_at,
    ...extra,
  })

  const month = [
    event('2026-11-13T23:30:00Z', 'pushed to', { push_data: { commit_count: 9, ref: 'main' } }), // local 14 Nov: future, ignored
    event('2026-11-12T23:30:00Z', 'pushed to', { push_data: { commit_count: 3, ref: 'main' } }), // local 13 Nov
    event('2026-11-13T08:00:00Z', 'approved', { target_type: 'MergeRequest' }),
    event('2026-11-10T09:00:00Z', 'opened', { target_type: 'MergeRequest' }),
    event('2026-11-05T10:00:00Z', 'joined'),
    event('2026-11-02T09:00:00Z', 'accepted', { target_type: 'MergeRequest' }),
    event('2026-11-02T10:00:00Z', 'commented on', { target_type: 'Note', note: { noteable_type: 'Issue', body: 'x' } }),
    event('2026-10-31T23:30:00Z', 'commented on', { target_type: 'DiffNote', note: { noteable_type: 'MergeRequest' } }), // local 1 Nov 00:30
    event('2026-10-31T22:30:00Z', 'pushed to', { push_data: { commit_count: 5 } }), // local 31 Oct 23:30: outside
    event('not a date', 'pushed to', { push_data: { commit_count: 5 } }),
  ]

  /** GitLab's EventsFinder in a UTC server: created_at > after.end_of_day and < before.beginning_of_day. */
  const served = (url: URL, events: ReturnType<typeof event>[]) => {
    const after = Date.parse(`${url.searchParams.get('after')}T23:59:59.999Z`)
    const before = Date.parse(`${url.searchParams.get('before')}T00:00:00.000Z`)
    return events.filter((e) => {
      const t = Date.parse(e.created_at)
      return Number.isNaN(t) || (t > after && t < before)
    })
  }

  const pagedSetup = (pages: (page: number, url: URL) => Response) => {
    const fetchMock = vi.fn<CodeReviewFetch>(async (raw) => {
      const url = new URL(raw)
      if (url.pathname === '/base/api/v4/user') return json({ id: 42, username: 'me' })
      if (url.pathname === EVENTS) return pages(Number(url.searchParams.get('page')), url)
      return json({ message: 'not found' }, 404)
    })
    return { client: createGitlabClient({ fetch: fetchMock, baseUrl: BASE, token: TOKEN }), fetchMock }
  }
  const eventCalls = (fetchMock: ReturnType<typeof pagedSetup>['fetchMock']) =>
    fetchMock.mock.calls.map(([u]) => new URL(u)).filter((u) => u.pathname === EVENTS)
  const fill = (n: number) => Array.from({ length: n }, () => event('2026-11-03T10:00:00Z', 'pushed to', { push_data: { commit_count: 1 } }))

  it('asks for the user events of the range (exclusive dates) with the token and no redirects', async () => {
    const { client, fetchMock } = pagedSetup((_, url) => json(served(url, month)))
    await client.contributions(NOW)
    const calls = eventCalls(fetchMock)
    expect(calls).toHaveLength(1)
    expect(Object.fromEntries(calls[0]!.searchParams)).toEqual({ after: '2026-10-30', before: '2026-11-15', per_page: '100', page: '1' })
    for (const [u, init] of fetchMock.mock.calls) {
      expect(u.startsWith(`${BASE}/api/v4/`)).toBe(true)
      expect(init?.redirect).toBe('manual')
      expect((init?.headers as Record<string, string>)['private-token']).toBe(TOKEN)
    }
  })

  it('reaches back to Monday when the week starts in the previous month', async () => {
    const { client, fetchMock } = pagedSetup((_, url) => json(served(url, [event('2026-11-30T10:00:00Z', 'opened', { target_type: 'MergeRequest' })])))
    const s = await client.contributions(new Date(2026, 11, 2, 9))
    expect(eventCalls(fetchMock)[0]!.searchParams.get('after')).toBe('2026-11-28')
    expect(eventCalls(fetchMock)[0]!.searchParams.get('before')).toBe('2026-12-04')
    expect(s.week.opened).toBe(1)
    expect(s.monthTotals.opened).toBe(0)
    expect(s.monthTotal).toBe(0)
  })

  it('classifies events by local day into the grid and the totals', async () => {
    const { client } = pagedSetup((_, url) => json(served(url, month)))
    const s = await client.contributions(NOW)
    expect(contributionSummarySchema.parse(s)).toEqual(s)
    const byDate = new Map(s.weeks.flat().map((d) => [d.date, d.count]))
    expect(byDate.get('2026-11-13')).toBe(2)
    expect(byDate.get('2026-11-10')).toBe(1)
    expect(byDate.get('2026-11-05')).toBe(0)
    expect(byDate.get('2026-11-02')).toBe(2)
    expect(byDate.get('2026-11-01')).toBe(1)
    expect(byDate.get('2026-11-14')).toBe(0)
    expect(byDate.get('2026-10-31')).toBe(0)
    expect(s.monthTotal).toBe(6)
    expect(s.activeDays).toBe(4)
    expect(s.today).toEqual({ commits: 3, opened: 0, merged: 0, reviews: 1 })
    expect(s.week).toEqual({ commits: 3, opened: 1, merged: 0, reviews: 1 })
    expect(s.monthTotals).toEqual({ commits: 3, opened: 1, merged: 1, reviews: 2 })
    expect(s.partial).toBe(false)
    expect(s.restricted).toBe(false)
  })

  it('keeps local-edge events GitLab filters by UTC dates: Madrid 00:30 on the 1st', async () => {
    // 2026-11-01 00:30 local = 2026-10-31T23:30Z: an `after` of the 31st would drop it server-side.
    const { client } = pagedSetup((_, url) => json(served(url, [event('2026-10-31T23:30:00Z', 'opened', { target_type: 'MergeRequest' })])))
    const s = await client.contributions(NOW)
    expect(s.monthTotals.opened).toBe(1)
    expect(s.weeks.flat().find((d) => d.date === '2026-11-01')?.count).toBe(1)
  })

  it('keeps local-edge events GitLab filters by UTC dates: a New York evening today', async () => {
    const tz = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      const now = new Date(2026, 10, 13, 20, 0) // 13 Nov 20:00 EST = 14 Nov 01:00Z
      expect(now.toISOString()).toBe('2026-11-14T01:00:00.000Z')
      // 13 Nov 19:30 EST = 14 Nov 00:30Z: a `before` of the 14th would drop it server-side.
      const { client } = pagedSetup((_, url) => json(served(url, [event('2026-11-14T00:30:00Z', 'approved', { target_type: 'MergeRequest' })])))
      const s = await client.contributions(now)
      expect(s.today.reviews).toBe(1)
      expect(s.weeks.flat().find((d) => d.date === '2026-11-13')?.count).toBe(1)
    } finally {
      process.env.TZ = tz
    }
    expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(-60)
  })

  it('pages in series until a page has fewer than 100 events', async () => {
    const { client, fetchMock } = pagedSetup((page) => json(page < 3 ? fill(100) : fill(5)))
    const s = await client.contributions(NOW)
    expect(eventCalls(fetchMock).map((u) => u.searchParams.get('page'))).toEqual(['1', '2', '3'])
    expect(s.monthTotals.commits).toBe(205)
    expect(s.partial).toBe(false)
  })

  it('stops on an empty X-Next-Page even with a full page', async () => {
    const { client, fetchMock } = pagedSetup((page) => json(fill(100), 200, { 'x-next-page': page === 2 ? '' : String(page + 1) }))
    const s = await client.contributions(NOW)
    expect(eventCalls(fetchMock)).toHaveLength(2)
    expect(s.partial).toBe(false)
  })

  it('stops after 10 pages and marks the data partial', async () => {
    const { client, fetchMock } = pagedSetup(() => json(fill(100)))
    const s = await client.contributions(NOW)
    expect(eventCalls(fetchMock)).toHaveLength(10)
    expect(s.partial).toBe(true)
    expect(s.monthTotals.commits).toBe(1000)
  })

  it('maps errors of the events request to codes; a redirect is never followed', async () => {
    const cases: [() => Response, CodeReviewErrorCode][] = [
      [() => json({}, 401), 'auth'],
      [() => json({}, 403), 'auth'],
      [() => json({}, 429), 'rate-limited'],
      [() => json({}, 503), 'server'],
      [() => json({ not: 'an array' }), 'invalid-response'],
      [() => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }), 'invalid-response'],
    ]
    for (const [response, code] of cases) {
      const { client, fetchMock } = pagedSetup(response)
      await expectCode(client.contributions(NOW), code)
      expect(eventCalls(fetchMock)).toHaveLength(1)
    }
  })

  it('a failure on a later page fails the whole query', async () => {
    const { client } = pagedSetup((page) => (page === 1 ? json(fill(100)) : json({}, 500)))
    await expectCode(client.contributions(NOW), 'server')
  })
})
