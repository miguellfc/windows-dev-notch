import { describe, expect, it } from 'vitest'
import { CodeReviewError, type CodeReviewFetch } from '../../../src/main/code-review/client-common'
import { createRedmineClient } from '../../../src/main/redmine/redmine-client'
import { redmineActivitySchema, redmineIssueDetailSchema, redmineIssueListSchema } from '../../../src/shared/redmine/schema'

const BASE = 'https://redmine.x.com/base'
const KEY = 'secret-api-key'
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

interface Call {
  url: URL
  method: string
  headers: Record<string, string>
  body: unknown
  init: RequestInit
}

const harness = (respond: (call: Call, index: number) => Response | Promise<Response>) => {
  const calls: Call[] = []
  const fetch: CodeReviewFetch = async (url, init = {}) => {
    const call: Call = {
      url: new URL(url),
      method: init.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      init,
    }
    calls.push(call)
    return respond(call, calls.length - 1)
  }
  return { calls, client: createRedmineClient({ fetch, apiKey: KEY, baseUrl: BASE }) }
}

const failingFetch: CodeReviewFetch = async () => {
  throw new TypeError('fetch failed')
}

const rawIssue = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  subject: `Task ${id}`,
  project: { id: 1, name: 'Proj' },
  status: { id: 2, name: 'In progress' },
  updated_on: '2026-11-12T10:00:00Z',
  ...extra,
})

/** Serves `total` issues paged by the `offset`/`limit` query. */
const pagedIssues =
  (total: number, reportedTotal: number = total) =>
  (call: Call) => {
    const offset = Number(call.url.searchParams.get('offset'))
    const limit = Number(call.url.searchParams.get('limit'))
    const issues = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => rawIssue(offset + i + 1))
    return json({ issues, total_count: reportedTotal, offset, limit })
  }

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
  } catch (error) {
    if (error instanceof CodeReviewError) return error.code
    throw error
  }
  return 'no-error'
}

describe('createRedmineClient', () => {
  it('refuses http:// unless loopback is allowed', () => {
    const fetch: CodeReviewFetch = async () => json({})
    expect(() => createRedmineClient({ fetch, apiKey: KEY, baseUrl: 'http://redmine.x.com' })).toThrow()
    expect(() => createRedmineClient({ fetch, apiKey: KEY, baseUrl: 'http://127.0.0.1:4000' })).toThrow()
    expect(() => createRedmineClient({ fetch, apiKey: KEY, baseUrl: 'http://127.0.0.1:4000', allowLoopbackHttp: true })).not.toThrow()
    expect(() => createRedmineClient({ fetch, apiKey: KEY, baseUrl: 'http://redmine.x.com', allowLoopbackHttp: true })).toThrow()
    expect(() => createRedmineClient({ fetch, apiKey: KEY, baseUrl: 'https://redmine.x.com/' })).toThrow()
  })

  it('builds issue URLs from the base URL', () => {
    const { client } = harness(() => json({}))
    expect(client.issueUrl(42)).toBe(`${BASE}/issues/42`)
  })

  it('never puts the API key in a request URL (header only)', async () => {
    const { client, calls } = harness((call) => {
      const path = call.url.pathname
      if (path.endsWith('/users/current.json')) return json({ user: { id: 7, login: 'alice' } })
      if (path.endsWith('/issues.json')) return json({ issues: [rawIssue(1)], total_count: 1 })
      if (path.endsWith('/issue_statuses.json')) return json({ issue_statuses: [{ id: 1, name: 'New' }] })
      if (path.endsWith('/time_entry_activities.json')) return json({ time_entry_activities: [] })
      if (path.endsWith('/time_entries.json') && call.method === 'GET') return json({ time_entries: [], total_count: 0 })
      if (call.method !== 'GET') return new Response(null, { status: 204 })
      return json({ issue: rawIssue(5) })
    })
    await client.viewer()
    await client.issues()
    await client.issue(5)
    await client.statuses()
    await client.activities()
    await client.timeEntries('2026-11-01', '2026-11-14')
    await client.updateIssue(5, { statusId: 3 })
    await client.logTime({ issueId: 5, spentOn: '2026-11-14', hours: 1, activityId: 9, comments: '' })
    expect(calls.length).toBeGreaterThanOrEqual(8)
    for (const call of calls) {
      expect(call.url.toString()).not.toContain(KEY)
      expect(call.url.searchParams.has('key')).toBe(false)
      expect(call.headers['x-redmine-api-key']).toBe(KEY)
    }
  })

  describe('viewer', () => {
    it('requests /users/current.json with the API key and uses "firstname lastname"', async () => {
      const { client, calls } = harness(() => json({ user: { id: 7, login: 'alice', firstname: 'Alice', lastname: 'Doe' } }))
      expect(await client.viewer()).toEqual({ id: 7, name: 'Alice Doe' })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.url.toString()).toBe(`${BASE}/users/current.json`)
      expect(calls[0]!.method).toBe('GET')
      expect(calls[0]!.headers['x-redmine-api-key']).toBe(KEY)
      expect(calls[0]!.init.redirect).toBe('manual')
    })

    it('falls back to the login without a name', async () => {
      const { client } = harness(() => json({ user: { id: 7, login: 'alice' } }))
      expect(await client.viewer()).toEqual({ id: 7, name: 'alice' })
      const blank = harness(() => json({ user: { id: 7, login: 'alice', firstname: '', lastname: ' ' } }))
      expect(await blank.client.viewer()).toEqual({ id: 7, name: 'alice' })
    })
  })

  describe('issues', () => {
    it('requests the open assigned issues of the first page', async () => {
      const { client, calls } = harness(pagedIssues(2))
      const list = await client.issues()
      expect(calls).toHaveLength(1)
      const { searchParams, pathname } = calls[0]!.url
      expect(pathname).toBe('/base/issues.json')
      expect(Object.fromEntries(searchParams)).toEqual({
        assigned_to_id: 'me',
        status_id: 'open',
        sort: 'updated_on:desc',
        limit: '100',
        offset: '0',
      })
      expect(calls[0]!.headers['x-redmine-api-key']).toBe(KEY)
      expect(list.truncated).toBe(false)
      expect(list.issues).toHaveLength(2)
      expect(redmineIssueListSchema.safeParse(list).success).toBe(true)
    })

    it('maps fields: spentHours = spent_hours ?? total_spent_hours ?? null', async () => {
      const { client } = harness(() =>
        json({
          issues: [rawIssue(1, { estimated_hours: 4.5, spent_hours: 2, total_spent_hours: 9 }), rawIssue(2, { total_spent_hours: 3 }), rawIssue(3)],
          total_count: 3,
        }),
      )
      const { issues } = await client.issues()
      expect(issues[0]).toEqual({
        id: 1,
        subject: 'Task 1',
        project: 'Proj',
        status: { id: 2, name: 'In progress' },
        estimatedHours: 4.5,
        spentHours: 2,
        updatedOn: '2026-11-12T10:00:00Z',
      })
      expect(issues[1]).toMatchObject({ estimatedHours: null, spentHours: 3 })
      expect(issues[2]).toMatchObject({ estimatedHours: null, spentHours: null })
    })

    it('pages through 250 issues in 3 requests', async () => {
      const { client, calls } = harness(pagedIssues(250))
      const list = await client.issues()
      expect(calls.map((c) => c.url.searchParams.get('offset'))).toEqual(['0', '100', '200'])
      expect(list.issues).toHaveLength(250)
      expect(list.truncated).toBe(false)
    })

    it('stops at 3 pages and flags truncated when there are 350', async () => {
      const { client, calls } = harness(pagedIssues(350))
      const list = await client.issues()
      expect(calls).toHaveLength(3)
      expect(list.issues).toHaveLength(300)
      expect(list.truncated).toBe(true)
    })

    it('is not truncated with exactly 300', async () => {
      const { client, calls } = harness(pagedIssues(300))
      const list = await client.issues()
      expect(calls).toHaveLength(3)
      expect(list.truncated).toBe(false)
    })

    it('does not loop when total_count is inconsistent', async () => {
      const { client, calls } = harness(pagedIssues(100, 100000))
      const list = await client.issues()
      expect(calls.length).toBeLessThanOrEqual(3)
      expect(list.issues).toHaveLength(100)
      const none = harness(() => json({ issues: [], total_count: 9999 }))
      expect((await none.client.issues()).issues).toEqual([])
      expect(none.calls).toHaveLength(1)
    })

    it('drops an issue seen on an earlier page (the list shifted while paging)', async () => {
      // Page 2 repeats issues 100 and 99 (two issues were updated meanwhile and moved to the top).
      const { client } = harness((call) => {
        const offset = Number(call.url.searchParams.get('offset'))
        if (offset === 0) return json({ issues: Array.from({ length: 100 }, (_, i) => rawIssue(i + 1)), total_count: 150 })
        return json({ issues: [rawIssue(100), rawIssue(99), ...Array.from({ length: 48 }, (_, i) => rawIssue(101 + i))], total_count: 150 })
      })
      const { issues } = await client.issues()
      const ids = issues.map((i) => i.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids).toHaveLength(148)
      expect(ids.slice(0, 3)).toEqual([1, 2, 3])
    })

    it('rejects an invalid body', async () => {
      const { client } = harness(() => json({ nope: true }))
      expect(await codeOf(client.issues())).toBe('invalid-response')
    })
  })

  describe('issue', () => {
    it('requests the detail with allowed_statuses', async () => {
      const { client, calls } = harness(() =>
        json({
          issue: rawIssue(5, {
            allowed_statuses: [
              { id: 2, name: 'In progress' },
              { id: 3, name: 'Done' },
            ],
          }),
        }),
      )
      const detail = await client.issue(5)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.url.pathname).toBe('/base/issues/5.json')
      expect(calls[0]!.url.searchParams.get('include')).toBe('allowed_statuses')
      expect(detail.allowedStatuses).toEqual([
        { id: 2, name: 'In progress' },
        { id: 3, name: 'Done' },
      ])
      expect(redmineIssueDetailSchema.safeParse(detail).success).toBe(true)
    })

    it('falls back to /issue_statuses.json when allowed_statuses is missing', async () => {
      const { client, calls } = harness((call) =>
        call.url.pathname.endsWith('/issue_statuses.json')
          ? json({
              issue_statuses: [
                { id: 1, name: 'New', is_closed: false },
                { id: 5, name: 'Closed', is_closed: true },
              ],
            })
          : json({ issue: rawIssue(5) }),
      )
      const detail = await client.issue(5)
      expect(calls.map((c) => c.url.pathname)).toEqual(['/base/issues/5.json', '/base/issue_statuses.json'])
      expect(detail.allowedStatuses).toEqual([
        { id: 1, name: 'New' },
        { id: 5, name: 'Closed' },
      ])
    })

    it('caches the statuses for the session', async () => {
      const { client, calls } = harness((call) =>
        call.url.pathname.endsWith('/issue_statuses.json') ? json({ issue_statuses: [{ id: 1, name: 'New' }] }) : json({ issue: rawIssue(5) }),
      )
      await client.issue(5)
      await client.issue(6)
      expect(calls.filter((c) => c.url.pathname.endsWith('/issue_statuses.json'))).toHaveLength(1)
    })

    it('a 404 on read is invalid-response', async () => {
      const { client } = harness(() => json({}, 404))
      expect(await codeOf(client.issue(5))).toBe('invalid-response')
    })
  })

  describe('statuses and activities', () => {
    it('requests /issue_statuses.json', async () => {
      const { client, calls } = harness(() => json({ issue_statuses: [{ id: 1, name: 'New' }] }))
      expect(await client.statuses()).toEqual([{ id: 1, name: 'New' }])
      expect(calls[0]!.url.toString()).toBe(`${BASE}/issue_statuses.json`)
    })

    it('requests the time entry activities, with is_default defaulting to false, cached', async () => {
      const { client, calls } = harness(() =>
        json({
          time_entry_activities: [
            { id: 9, name: 'Dev', is_default: true },
            { id: 10, name: 'Test' },
          ],
        }),
      )
      const activities = await client.activities()
      expect(activities).toEqual([
        { id: 9, name: 'Dev', isDefault: true },
        { id: 10, name: 'Test', isDefault: false },
      ])
      expect(activities.every((a) => redmineActivitySchema.safeParse(a).success)).toBe(true)
      expect(calls[0]!.url.toString()).toBe(`${BASE}/enumerations/time_entry_activities.json`)
      await client.activities()
      expect(calls).toHaveLength(1)
    })

    it('does not cache a failure', async () => {
      let n = 0
      const { client, calls } = harness(() => (n++ === 0 ? json({}, 500) : json({ time_entry_activities: [] })))
      expect(await codeOf(client.activities())).toBe('server')
      expect(await client.activities()).toEqual([])
      expect(calls).toHaveLength(2)
    })
  })

  describe('timeEntries', () => {
    const entries =
      (total: number, reportedTotal: number = total) =>
      (call: Call) => {
        const offset = Number(call.url.searchParams.get('offset'))
        const limit = Number(call.url.searchParams.get('limit'))
        const time_entries = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, () => ({ spent_on: '2026-11-10', hours: 0.5 }))
        return json({ time_entries, total_count: reportedTotal })
      }

    it('requests the user entries between from and to', async () => {
      const { client, calls } = harness(() =>
        json({
          time_entries: [
            { spent_on: '2026-11-10', hours: 1.5 },
            { spent_on: '2026-11-11', hours: 2 },
          ],
          total_count: 2,
        }),
      )
      expect(await client.timeEntries('2026-11-01', '2026-11-14')).toEqual([
        { date: '2026-11-10', hours: 1.5 },
        { date: '2026-11-11', hours: 2 },
      ])
      expect(calls).toHaveLength(1)
      expect(calls[0]!.url.pathname).toBe('/base/time_entries.json')
      expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
        user_id: 'me',
        from: '2026-11-01',
        to: '2026-11-14',
        limit: '100',
        offset: '0',
      })
    })

    it('pages until a short page', async () => {
      const { client, calls } = harness(entries(250))
      expect(await client.timeEntries('2026-11-01', '2026-11-14')).toHaveLength(250)
      expect(calls).toHaveLength(3)
    })

    it('reads at most 10 pages', async () => {
      const { client, calls } = harness(entries(5000))
      expect(await client.timeEntries('2026-11-01', '2026-11-14')).toHaveLength(1000)
      expect(calls).toHaveLength(10)
    })

    it('does not loop when total_count is inconsistent', async () => {
      const { client, calls } = harness(entries(40, 100000))
      expect(await client.timeEntries('2026-11-01', '2026-11-14')).toHaveLength(40)
      expect(calls).toHaveLength(1)
    })

    it.each(['2026-11-1', '14/11/2026', '2026-11-14T10:00:00Z', '2026-13-01', ''])('rejects a malformed spent_on (%s) as invalid-response', async (spentOn) => {
      const { client } = harness(() => json({ time_entries: [{ spent_on: spentOn, hours: 1 }], total_count: 1 }))
      expect(await codeOf(client.timeEntries('2026-11-01', '2026-11-14'))).toBe('invalid-response')
    })
  })

  describe('read errors', () => {
    it.each([
      [401, 'auth'],
      [403, 'auth'],
      [500, 'server'],
      [429, 'rate-limited'],
      [404, 'invalid-response'],
    ])('maps %i to %s', async (status, code) => {
      const { client } = harness(() => json({}, status))
      expect(await codeOf(client.viewer())).toBe(code)
    })

    it('maps a redirect to invalid-response', async () => {
      const { client } = harness(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }))
      expect(await codeOf(client.issues())).toBe('invalid-response')
    })

    it('maps a network failure to network', async () => {
      const client = createRedmineClient({ fetch: failingFetch, apiKey: KEY, baseUrl: BASE })
      expect(await codeOf(client.viewer())).toBe('network')
    })
  })

  describe('updateIssue', () => {
    it('PUTs the status id and treats 204 as ok', async () => {
      const { client, calls } = harness(() => new Response(null, { status: 204 }))
      expect(await client.updateIssue(5, { statusId: 3 })).toEqual({ ok: true })
      expect(calls[0]!.method).toBe('PUT')
      expect(calls[0]!.url.toString()).toBe(`${BASE}/issues/5.json`)
      expect(calls[0]!.headers['x-redmine-api-key']).toBe(KEY)
      expect(calls[0]!.headers['content-type']).toBe('application/json')
      expect(calls[0]!.body).toEqual({ issue: { status_id: 3 } })
      expect(calls[0]!.init.redirect).toBe('manual')
    })

    it('PUTs the estimated hours, and null clears them', async () => {
      const { client, calls } = harness(() => new Response(null, { status: 204 }))
      await client.updateIssue(5, { estimatedHours: 2.5 })
      await client.updateIssue(5, { estimatedHours: null })
      expect(calls[0]!.body).toEqual({ issue: { estimated_hours: 2.5 } })
      expect(calls[1]!.body).toEqual({ issue: { estimated_hours: null } })
    })

    it.each([
      [401, { ok: false, reason: 'auth' }],
      [403, { ok: false, reason: 'forbidden' }],
      [404, { ok: false, reason: 'not-found' }],
      [500, { ok: false, reason: 'server' }],
      [429, { ok: false, reason: 'server' }],
      [400, { ok: false, reason: 'invalid-response' }],
    ])('maps %i without throwing', async (status, expected) => {
      const { client } = harness(() => json({}, status))
      expect(await client.updateIssue(5, { statusId: 3 })).toEqual(expected)
    })

    it('maps 422 to validation with trimmed messages (at most 3)', async () => {
      const long = 'x'.repeat(300)
      const { client } = harness(() => json({ errors: ['Status is invalid', long, 'c', 'd'] }, 422))
      expect(await client.updateIssue(5, { statusId: 3 })).toEqual({
        ok: false,
        reason: 'validation',
        messages: ['Status is invalid', 'x'.repeat(200), 'c'],
      })
    })

    it('maps a 422 without a readable body to validation without messages', async () => {
      const { client } = harness(() => new Response('<html>', { status: 422 }))
      expect(await client.updateIssue(5, { statusId: 3 })).toEqual({ ok: false, reason: 'validation' })
    })

    it('maps a redirect to invalid-response and a network failure to network', async () => {
      const redirect = harness(() => new Response(null, { status: 302 }))
      expect(await redirect.client.updateIssue(5, { statusId: 3 })).toEqual({ ok: false, reason: 'invalid-response' })
      const client = createRedmineClient({ fetch: failingFetch, apiKey: KEY, baseUrl: BASE })
      expect(await client.updateIssue(5, { statusId: 3 })).toEqual({ ok: false, reason: 'network' })
    })
  })

  describe('logTime', () => {
    const entry = { issueId: 5, spentOn: '2026-11-14', hours: 1.5, activityId: 9, comments: 'work' }

    it('POSTs the time entry and treats 201 as ok', async () => {
      const { client, calls } = harness(() => json({ time_entry: { id: 1 } }, 201))
      expect(await client.logTime(entry)).toEqual({ ok: true })
      expect(calls[0]!.method).toBe('POST')
      expect(calls[0]!.url.toString()).toBe(`${BASE}/time_entries.json`)
      expect(calls[0]!.headers['x-redmine-api-key']).toBe(KEY)
      expect(calls[0]!.body).toEqual({
        time_entry: { issue_id: 5, spent_on: '2026-11-14', hours: 1.5, activity_id: 9, comments: 'work' },
      })
    })

    it('maps 422, 403 and 401 to results', async () => {
      expect(await harness(() => json({ errors: ['Hours is invalid'] }, 422)).client.logTime(entry)).toEqual({
        ok: false,
        reason: 'validation',
        messages: ['Hours is invalid'],
      })
      expect(await harness(() => json({}, 403)).client.logTime(entry)).toEqual({ ok: false, reason: 'forbidden' })
      expect(await harness(() => json({}, 401)).client.logTime(entry)).toEqual({ ok: false, reason: 'auth' })
    })
  })
})
