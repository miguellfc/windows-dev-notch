import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeReviewError } from '../../../src/main/code-review/client-common'
import { ExposedIpcError } from '../../../src/main/ipc/errors'
import type { RedmineClient } from '../../../src/main/redmine/redmine-client'
import {
  REDMINE_BACKOFF_MS,
  REDMINE_MANUAL_REFRESH_MIN_MS,
  REDMINE_SUMMARY_TICK_MS,
  REDMINE_TICK_MS,
  createRedmineIntegration,
  parseRedmineBaseOverride,
} from '../../../src/main/redmine/redmine-integration'
import type { RedmineIssue, RedmineState, RedmineSummaryChanged, RedmineWriteResult } from '../../../src/shared/redmine/schema'
import type { RedmineSettings } from '../../../src/shared/settings/schema'
import { createMemoryLogger } from '../helpers/memory-logger'

const URL_A = 'https://redmine.example.com/base'
const URL_B = 'https://other.example.com'
const KEY = 'SECRETKEY-123'
const SUBJECT = 'Confidential subject'

const issue = (id: number): RedmineIssue => ({
  id,
  subject: `${SUBJECT} ${id}`,
  project: 'Hidden project',
  status: { id: 2, name: 'In progress' },
  estimatedHours: null,
  spentHours: null,
  updatedOn: '2026-11-12T10:00:00Z',
})

type Fn<T extends (...args: never[]) => unknown> = ReturnType<typeof vi.fn<T>>
interface FakeClient extends RedmineClient {
  viewer: Fn<RedmineClient['viewer']>
  issues: Fn<RedmineClient['issues']>
  issue: Fn<RedmineClient['issue']>
  activities: Fn<RedmineClient['activities']>
  updateIssue: Fn<RedmineClient['updateIssue']>
  logTime: Fn<RedmineClient['logTime']>
  timeEntries: Fn<RedmineClient['timeEntries']>
}

const makeClient = (baseUrl: string): FakeClient => ({
  viewer: vi.fn(async () => ({ id: 7, name: 'Alice Doe' })),
  issues: vi.fn(async () => ({ issues: [issue(12), issue(13)], truncated: false })),
  issue: vi.fn(async (id: number) => ({ ...issue(id), allowedStatuses: [{ id: 3, name: 'Done' }] })),
  statuses: vi.fn(async () => []),
  activities: vi.fn(async () => [{ id: 9, name: 'Dev', isDefault: true }]),
  updateIssue: vi.fn(async (): Promise<RedmineWriteResult> => ({ ok: true })),
  logTime: vi.fn(async (): Promise<RedmineWriteResult> => ({ ok: true })),
  timeEntries: vi.fn(async (from: string, to: string) =>
    from === to
      ? [
          { date: from, hours: 1.5 },
          { date: from, hours: 2.25 },
        ]
      : [],
  ),
  issueUrl: (id: number) => `${baseUrl}/issues/${id}`,
})

interface SetupOptions {
  url?: string
  key?: string | null
  started?: boolean
  updateFails?: boolean
  now?: string
}

function setup(options: SetupOptions = {}) {
  // Local time: Saturday 14 Nov 2026, 10:00.
  vi.useFakeTimers({ now: new Date(options.now ?? '2026-11-14T10:00:00') })
  const logger = createMemoryLogger()
  let current: { redmine: RedmineSettings } = {
    redmine: { url: options.url ?? URL_A, dailyTargetHours: 8, endOfDay: { enabled: true, time: '18:00', sound: true } },
  }
  const listeners = new Set<(s: typeof current) => void>()
  const notify = () => {
    for (const listener of listeners) listener(current)
  }
  const settings = {
    get: () => current,
    onChange: (listener: (s: typeof current) => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    update: vi.fn(async (patch: { redmine: { url: string } }) => {
      if (options.updateFails) throw new Error('disk full')
      current = { redmine: { ...current.redmine, ...patch.redmine } }
      notify()
      return current
    }),
  }
  const changeUrl = (url: string) => {
    current = { redmine: { ...current.redmine, url } }
    notify()
  }

  const stored = { key: options.key === undefined ? KEY : options.key }
  const tokenStore = {
    load: vi.fn(async () => stored.key),
    save: vi.fn(async (key: string) => {
      stored.key = key
    }),
    clear: vi.fn(async () => {
      stored.key = null
    }),
    persistent: true,
  }

  const clients: { baseUrl: string; key: string; client: FakeClient }[] = []
  let prepare: (client: FakeClient, key: string) => void = () => undefined
  const clientFactory = vi.fn((baseUrl: string, key: string) => {
    const client = makeClient(baseUrl)
    prepare(client, key)
    clients.push({ baseUrl, key, client })
    return client
  })

  const emitted: RedmineState[] = []
  const summaryEvents: RedmineSummaryChanged[] = []
  const openExternal = vi.fn(async () => undefined)
  const integration = createRedmineIntegration({
    settings,
    tokenStore,
    clientFactory,
    timers: { setTimeout, clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
    now: () => Date.now(),
    emit: (state) => emitted.push(state),
    emitSummary: (change) => summaryEvents.push(change),
    openExternal,
    logger,
  })
  if (options.started ?? true) integration.start()

  const last = () => {
    const found = clients.at(-1)
    if (!found) throw new Error('no client')
    return found.client
  }
  return {
    integration,
    logger,
    settings,
    changeUrl,
    tokenStore,
    stored,
    clients,
    clientFactory,
    emitted,
    summaryEvents,
    openExternal,
    last,
    setPrepare: (fn: typeof prepare) => {
      prepare = fn
    },
  }
}

/** Lets pending promises (and timers due now) run. */
const flush = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('parseRedmineBaseOverride', () => {
  it('accepts only an exact http://127.0.0.1:<port> origin', () => {
    expect(parseRedmineBaseOverride(undefined)).toBeUndefined()
    expect(parseRedmineBaseOverride('')).toBeUndefined()
    expect(parseRedmineBaseOverride('http://127.0.0.1:4321')).toBe('http://127.0.0.1:4321')
    for (const bad of ['http://localhost:4321', 'https://127.0.0.1:4321', 'http://127.0.0.1:4321/', 'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:70000', 'http://evil.test']) {
      expect(parseRedmineBaseOverride(bad)).toBeUndefined()
    }
  })
})

describe('redmine integration: start and rhythm', () => {
  it('is unconfigured without a key and never builds a client', async () => {
    const t = setup({ key: null })
    await t.integration.ready
    await flush()
    expect(t.integration.state()).toEqual({ status: 'unconfigured', account: null, todayHours: null, updatedAt: null, persistent: true })
    expect(t.integration.todayHours()).toBeNull()
    await flush(REDMINE_TICK_MS * 3)
    expect(t.clientFactory).not.toHaveBeenCalled()
  })

  it('without a server forgets a stored key and stays unconfigured', async () => {
    const t = setup({ url: '' })
    await t.integration.ready
    await flush()
    expect(t.integration.state().status).toBe('unconfigured')
    expect(t.tokenStore.clear).toHaveBeenCalled()
    expect(t.tokenStore.load).not.toHaveBeenCalled()
    expect(t.clientFactory).not.toHaveBeenCalled()
  })

  it("with a key queries at once (account, issues, today's hours) and then every 300 s", async () => {
    const t = setup()
    await t.integration.ready
    await flush()
    expect(t.clientFactory).toHaveBeenCalledWith(URL_A, KEY)
    const client = t.last()
    expect(client.viewer).toHaveBeenCalledTimes(1)
    expect(client.issues).toHaveBeenCalledTimes(1)
    expect(client.timeEntries).toHaveBeenCalledWith('2026-11-14', '2026-11-14')
    expect(t.integration.state()).toEqual({ status: 'ok', account: 'Alice Doe', todayHours: 3.75, updatedAt: Date.now(), persistent: true })
    expect(t.integration.todayHours()).toBe(3.75)
    expect(t.emitted.at(-1)?.todayHours).toBe(3.75)
    // A reading from yesterday is no longer today's hours (the next poll brings the new day's).
    vi.setSystemTime(Date.now() + 24 * 3_600_000)
    expect(t.integration.todayHours()).toBeNull()
    vi.setSystemTime(Date.now() - 24 * 3_600_000)
    await flush(REDMINE_TICK_MS - 1)
    expect(client.issues).toHaveBeenCalledTimes(1)
    await flush(1)
    expect(client.issues).toHaveBeenCalledTimes(2)
    expect(client.timeEntries).toHaveBeenCalledTimes(2)
    // The account is asked once per session.
    expect(client.viewer).toHaveBeenCalledTimes(1)
  })

  it('sums float hours without noise', async () => {
    const t = setup()
    t.setPrepare((c) =>
      c.timeEntries.mockResolvedValue([
        { date: '2026-11-14', hours: 0.1 },
        { date: '2026-11-14', hours: 0.2 },
      ]),
    )
    await t.integration.ready
    await flush()
    expect(t.integration.todayHours()).toBe(0.3)
  })

  it('does not query before start()', async () => {
    const t = setup({ started: false })
    await t.integration.ready
    await flush(REDMINE_TICK_MS * 2)
    expect(t.clients[0]?.client.issues ?? vi.fn()).not.toHaveBeenCalled()
    t.integration.start()
    await flush()
    expect(t.last().issues).toHaveBeenCalledTimes(1)
  })

  it('manual refresh queries at once, at most every 5 s', async () => {
    const t = setup()
    await t.integration.ready
    await flush()
    const client = t.last()
    t.integration.refresh()
    await flush()
    expect(client.issues).toHaveBeenCalledTimes(2)
    t.integration.refresh()
    await flush(REDMINE_MANUAL_REFRESH_MIN_MS - 1_000)
    expect(client.issues).toHaveBeenCalledTimes(2)
    t.integration.refresh()
    await flush(1_000)
    t.integration.refresh()
    await flush()
    expect(client.issues).toHaveBeenCalledTimes(3)
  })

  it('failures go offline with growing waits (1, 2, 4, 5, 5 min) and keep the last data', async () => {
    const t = setup()
    await t.integration.ready
    await flush()
    const client = t.last()
    client.issues.mockRejectedValue(new CodeReviewError('network'))
    await flush(REDMINE_TICK_MS)
    expect(t.integration.state()).toMatchObject({ status: 'offline', account: 'Alice Doe', todayHours: 3.75 })
    expect((await t.integration.issues()).issues).toHaveLength(2)
    let calls = client.issues.mock.calls.length
    for (const wait of [...REDMINE_BACKOFF_MS, REDMINE_BACKOFF_MS.at(-1)!]) {
      await flush(wait - 1)
      expect(client.issues).toHaveBeenCalledTimes(calls)
      await flush(1)
      expect(client.issues).toHaveBeenCalledTimes(++calls)
    }
    client.issues.mockResolvedValue({ issues: [], truncated: false })
    await flush(REDMINE_BACKOFF_MS.at(-1)!)
    expect(t.integration.state().status).toBe('ok')
    // Back to the normal rhythm.
    calls = client.issues.mock.calls.length
    await flush(REDMINE_TICK_MS)
    expect(client.issues).toHaveBeenCalledTimes(calls + 1)
  })

  it("offline after midnight no longer reports yesterday's hours as today's", async () => {
    const t = setup()
    await t.integration.ready
    await flush()
    expect(t.integration.state().todayHours).toBe(3.75)
    const client = t.last()
    client.issues.mockRejectedValue(new CodeReviewError('network'))
    vi.setSystemTime(new Date('2026-11-15T09:00:00'))
    t.integration.refresh()
    await flush()
    expect(t.integration.state()).toMatchObject({ status: 'offline', account: 'Alice Doe', todayHours: null })
    expect(t.emitted.at(-1)).toMatchObject({ status: 'offline', todayHours: null })
    expect(t.integration.todayHours()).toBeNull()
  })

  it('a rejected key turns auth-error, hides the hours and stops polling', async () => {
    const t = setup()
    await t.integration.ready
    await flush()
    const client = t.last()
    client.timeEntries.mockRejectedValue(new CodeReviewError('auth'))
    await flush(REDMINE_TICK_MS)
    expect(t.integration.state()).toMatchObject({ status: 'auth-error', todayHours: null })
    expect(t.integration.todayHours()).toBeNull()
    expect((await t.integration.issues()).issues).toEqual([])
    const calls = client.issues.mock.calls.length
    t.integration.setViewOpen(true)
    t.integration.refresh()
    await flush(60 * 60_000)
    expect(client.issues).toHaveBeenCalledTimes(calls)
  })
})

describe('redmine integration: setKey and clear', () => {
  it('validates the key with viewer(), then saves the normalized URL and the key', async () => {
    const t = setup({ url: '', key: null })
    await t.integration.ready
    await expect(t.integration.setKey(' https://redmine.example.com/base/ ', ` ${KEY} `)).resolves.toEqual({ ok: true, account: 'Alice Doe' })
    expect(t.clientFactory).toHaveBeenCalledWith(URL_A, KEY)
    expect(t.settings.update).toHaveBeenCalledWith({ redmine: { url: URL_A } })
    expect(t.settings.get().redmine.url).toBe(URL_A)
    expect(t.tokenStore.save).toHaveBeenCalledWith(KEY)
    expect(t.tokenStore.clear).not.toHaveBeenCalledAfter(t.tokenStore.save)
    expect(t.stored.key).toBe(KEY)
    await flush()
    expect(t.integration.state()).toMatchObject({ status: 'ok', account: 'Alice Doe', todayHours: 3.75 })
  })

  it('refuses a non-https or malformed URL before building a client', async () => {
    const t = setup({ url: '', key: null })
    await t.integration.ready
    for (const url of ['http://redmine.example.com', 'https://u:p@redmine.example.com', 'https://redmine.example.com/?q=1', 'nope']) {
      await expect(t.integration.setKey(url, KEY)).resolves.toEqual({ ok: false, reason: 'url' })
    }
    expect(t.clientFactory).not.toHaveBeenCalled()
    expect(t.settings.update).not.toHaveBeenCalled()
    expect(t.tokenStore.save).not.toHaveBeenCalled()
  })

  it.each([
    ['auth', 'auth'],
    ['network', 'network'],
    ['server', 'network'],
    ['invalid-response', 'url'],
  ] as const)('a %s failure of the check answers %s and saves nothing', async (code, reason) => {
    const t = setup({ url: '', key: null })
    t.setPrepare((c) => c.viewer.mockRejectedValue(new CodeReviewError(code)))
    await t.integration.ready
    await expect(t.integration.setKey(URL_A, KEY)).resolves.toEqual({ ok: false, reason })
    expect(t.settings.update).not.toHaveBeenCalled()
    expect(t.tokenStore.save).not.toHaveBeenCalled()
    expect(t.integration.state().status).toBe('unconfigured')
  })

  it('a URL that cannot be saved keeps the old session and saves no key', async () => {
    const t = setup({ updateFails: true })
    await t.integration.ready
    await flush()
    await expect(t.integration.setKey(URL_B, 'other-key')).resolves.toEqual({ ok: false, reason: 'network' })
    expect(t.tokenStore.save).not.toHaveBeenCalled()
    expect(t.integration.state()).toMatchObject({ status: 'ok', account: 'Alice Doe' })
  })

  it('clear forgets the session and the stored key', async () => {
    const t = setup()
    await t.integration.ready
    await flush()
    await t.integration.clear()
    expect(t.integration.state()).toEqual({ status: 'unconfigured', account: null, todayHours: null, updatedAt: null, persistent: true })
    expect(t.stored.key).toBeNull()
    const client = t.last()
    const calls = client.issues.mock.calls.length
    await flush(REDMINE_TICK_MS * 2)
    expect(client.issues).toHaveBeenCalledTimes(calls)
  })

  it('a server changed from outside clears the key and restarts the session', async () => {
    const t = setup()
    await t.integration.ready
    await flush()
    const client = t.last()
    t.changeUrl(URL_B)
    await flush()
    expect(t.integration.state().status).toBe('unconfigured')
    expect(t.stored.key).toBeNull()
    const calls = client.issues.mock.calls.length
    await flush(REDMINE_TICK_MS * 2)
    expect(client.issues).toHaveBeenCalledTimes(calls)
    expect(t.clientFactory).toHaveBeenCalledTimes(1)
    // A new key for the new server works as usual.
    await expect(t.integration.setKey(URL_B, 'new-key')).resolves.toEqual({ ok: true, account: 'Alice Doe' })
    expect(t.clientFactory).toHaveBeenLastCalledWith(URL_B, 'new-key')
    expect(t.stored.key).toBe('new-key')
  })

  it('its own URL save is not taken for an outside change', async () => {
    const t = setup()
    await t.integration.ready
    await flush()
    await expect(t.integration.setKey(URL_B, 'new-key')).resolves.toEqual({ ok: true, account: 'Alice Doe' })
    await flush()
    expect(t.stored.key).toBe('new-key')
    expect(t.integration.state().status).toBe('ok')
  })
})

describe('redmine integration: reads and writes', () => {
  it('issue and activities go through the client; reads fail with UNAVAILABLE when not connected', async () => {
    const t = setup()
    await t.integration.ready
    await flush()
    await expect(t.integration.issue(12)).resolves.toMatchObject({ id: 12, allowedStatuses: [{ id: 3, name: 'Done' }] })
    await expect(t.integration.activities()).resolves.toEqual([{ id: 9, name: 'Dev', isDefault: true }])
    t.last().issue.mockRejectedValueOnce(new CodeReviewError('network'))
    await expect(t.integration.issue(12)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    const none = setup({ key: null })
    await none.integration.ready
    await expect(none.integration.issue(12)).rejects.toBeInstanceOf(ExposedIpcError)
    await expect(none.integration.activities()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('a read rejected for auth turns the session auth-error', async () => {
    const t = setup()
    await t.integration.ready
    await flush()
    t.last().activities.mockRejectedValue(new CodeReviewError('auth'))
    await expect(t.integration.activities()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(t.integration.state().status).toBe('auth-error')
  })

  it("a successful write asks again for issues and today's hours (and the summary with the view open) and publishes", async () => {
    const t = setup()
    await t.integration.ready
    await flush()
    t.integration.setViewOpen(true)
    await flush()
    const client = t.last()
    const issues = client.issues.mock.calls.length
    const entries = client.timeEntries.mock.calls.length
    const emitted = t.emitted.length
    const summaries = t.summaryEvents.length
    client.timeEntries.mockResolvedValue([{ date: '2026-11-14', hours: 5.5 }])
    await expect(t.integration.updateIssue({ id: 12, statusId: 3 })).resolves.toEqual({ ok: true })
    expect(client.updateIssue).toHaveBeenCalledWith(12, { statusId: 3 })
    expect(client.issues).toHaveBeenCalledTimes(issues + 1)
    // Today's hours and the month summary.
    expect(client.timeEntries).toHaveBeenCalledTimes(entries + 2)
    expect(t.emitted.length).toBeGreaterThan(emitted)
    expect(t.integration.todayHours()).toBe(5.5)
    expect(t.summaryEvents.length).toBe(summaries + 1)

    await expect(t.integration.logTime({ issueId: 12, spentOn: '2026-11-14', hours: 1, activityId: 9, comments: '' })).resolves.toEqual({ ok: true })
    expect(client.logTime).toHaveBeenCalledWith({ issueId: 12, spentOn: '2026-11-14', hours: 1, activityId: 9, comments: '' })
    expect(client.issues).toHaveBeenCalledTimes(issues + 2)
  })

  it('passes only the fields given to updateIssue (null clears the estimate)', async () => {
    const t = setup()
    await t.integration.ready
    await flush()
    await t.integration.updateIssue({ id: 12, estimatedHours: null })
    expect(t.last().updateIssue).toHaveBeenCalledWith(12, { estimatedHours: null })
  })

  it('a 403 on a write keeps the session ok and returns forbidden without refreshing', async () => {
    const t = setup()
    await t.integration.ready
    await flush()
    const client = t.last()
    client.updateIssue.mockResolvedValue({ ok: false, reason: 'forbidden' })
    const issues = client.issues.mock.calls.length
    await expect(t.integration.updateIssue({ id: 12, statusId: 3 })).resolves.toEqual({ ok: false, reason: 'forbidden' })
    expect(t.integration.state().status).toBe('ok')
    expect(client.issues).toHaveBeenCalledTimes(issues)
    client.logTime.mockResolvedValue({ ok: false, reason: 'validation', messages: ['Hours is invalid'] })
    await expect(t.integration.logTime({ issueId: 12, spentOn: '2026-11-14', hours: 1, activityId: 9, comments: '' })).resolves.toEqual({
      ok: false,
      reason: 'validation',
      messages: ['Hours is invalid'],
    })
    expect(t.integration.state().status).toBe('ok')
  })

  it('a 401 on a write turns the session auth-error', async () => {
    const t = setup()
    await t.integration.ready
    await flush()
    t.last().logTime.mockResolvedValue({ ok: false, reason: 'auth' })
    await expect(t.integration.logTime({ issueId: 12, spentOn: '2026-11-14', hours: 1, activityId: 9, comments: '' })).resolves.toEqual({ ok: false, reason: 'auth' })
    expect(t.integration.state().status).toBe('auth-error')
  })

  it('a write without a session answers auth and calls nothing', async () => {
    const t = setup({ key: null })
    await t.integration.ready
    await expect(t.integration.updateIssue({ id: 12, statusId: 3 })).resolves.toEqual({ ok: false, reason: 'auth' })
    expect(t.clientFactory).not.toHaveBeenCalled()
  })
})

describe('redmine integration: month summary', () => {
  it('is queried only with the view open: at once, then every 900 s, and stops when it closes', async () => {
    const t = setup()
    await t.integration.ready
    await flush(REDMINE_SUMMARY_TICK_MS * 2)
    const client = t.last()
    const ranged = () => client.timeEntries.mock.calls.filter(([from, to]) => from !== to).length
    expect(ranged()).toBe(0)
    await expect(t.integration.summary()).resolves.toEqual({ summary: null, error: false })

    t.integration.setViewOpen(true)
    await flush()
    expect(ranged()).toBe(1)
    expect(t.summaryEvents).toEqual([{ error: false }])
    await flush(REDMINE_SUMMARY_TICK_MS - 1)
    expect(ranged()).toBe(1)
    await flush(1)
    expect(ranged()).toBe(2)

    t.integration.setViewOpen(false)
    await flush(REDMINE_SUMMARY_TICK_MS * 3)
    expect(ranged()).toBe(2)
  })

  it('covers the 1st of the month to today and sums today, the week (from Monday) and the month', async () => {
    const t = setup()
    t.setPrepare((c) =>
      c.timeEntries.mockImplementation(async (from, to) =>
        from === to
          ? [{ date: from, hours: 2 }]
          : [
              { date: '2026-11-02', hours: 8 },
              { date: '2026-11-09', hours: 4 },
              { date: '2026-11-09', hours: 3.5 },
              { date: '2026-11-13', hours: 6 },
              { date: '2026-11-14', hours: 2 },
            ],
      ),
    )
    await t.integration.ready
    await flush()
    t.integration.setViewOpen(true)
    await flush()
    expect(t.last().timeEntries).toHaveBeenCalledWith('2026-11-01', '2026-11-14')
    const { summary, error } = await t.integration.summary()
    expect(error).toBe(false)
    expect(summary).toMatchObject({ month: '2026-11', today: 2, week: 15.5, monthTotal: 23.5 })
    expect(summary?.days).toHaveLength(14)
    expect(summary?.days[0]).toEqual({ date: '2026-11-01', hours: 0 })
    expect(summary?.days.find((d) => d.date === '2026-11-09')).toEqual({ date: '2026-11-09', hours: 7.5 })
  })

  it('starts on the Monday of the week when it falls in the previous month', async () => {
    // Wednesday 2 Dec 2026: the week began on Monday 30 Nov.
    const t = setup({ now: '2026-12-02T10:00:00' })
    t.setPrepare((c) =>
      c.timeEntries.mockImplementation(async (from, to) =>
        from === to
          ? []
          : [
              { date: '2026-11-30', hours: 4 },
              { date: '2026-12-01', hours: 3 },
            ],
      ),
    )
    await t.integration.ready
    await flush()
    t.integration.setViewOpen(true)
    await flush()
    expect(t.last().timeEntries).toHaveBeenCalledWith('2026-11-30', '2026-12-02')
    const { summary } = await t.integration.summary()
    expect(summary).toMatchObject({ month: '2026-12', today: 0, week: 7, monthTotal: 3 })
    expect(summary?.days.map((d) => d.date)).toEqual(['2026-12-01', '2026-12-02'])
  })

  it('a failed query keeps the last summary and flags the error', async () => {
    const t = setup()
    await t.integration.ready
    await flush()
    t.integration.setViewOpen(true)
    await flush()
    const client = t.last()
    client.timeEntries.mockImplementation(async (from, to) => {
      if (from === to) return []
      throw new CodeReviewError('server')
    })
    await flush(REDMINE_SUMMARY_TICK_MS)
    const result = await t.integration.summary()
    expect(result.error).toBe(true)
    expect(result.summary).not.toBeNull()
    expect(t.summaryEvents.at(-1)).toEqual({ error: true })
    expect(t.integration.state().status).toBe('ok')
  })
})

describe('redmine integration: open', () => {
  it('opens only issues of the last list sent, on the configured server', async () => {
    const t = setup()
    await t.integration.ready
    await flush()
    expect(() => t.integration.open(12)).toThrow(ExposedIpcError)
    await t.integration.issues()
    t.integration.open(12)
    await flush()
    expect(t.openExternal).toHaveBeenCalledWith(`${URL_A}/issues/12`)
    expect(() => t.integration.open(99)).toThrow(ExposedIpcError)
    expect(t.openExternal).toHaveBeenCalledTimes(1)
  })

  it('opens an issue read with issue(id) even after it left the open list (e.g. closed)', async () => {
    const t = setup()
    await t.integration.ready
    await flush()
    await t.integration.issues()
    await t.integration.issue(12)
    // The issue is closed: the next list no longer has it.
    t.last().issues.mockResolvedValue({ issues: [issue(13)], truncated: false })
    t.integration.refresh()
    await flush()
    await t.integration.issues()
    t.integration.open(12)
    await flush()
    expect(t.openExternal).toHaveBeenCalledWith(`${URL_A}/issues/12`)
    // A read issue still goes through the origin check.
    await t.integration.issue(55)
    t.last().issueUrl = (id) => `https://evil.example.com/issues/${id}`
    expect(() => t.integration.open(55)).toThrow(ExposedIpcError)
    // A new session forgets the ids read before.
    await t.integration.clear()
    expect(() => t.integration.open(12)).toThrow(ExposedIpcError)
    expect(t.openExternal).toHaveBeenCalledTimes(1)
  })

  it('refuses an issue URL outside the configured origin', async () => {
    const t = setup()
    t.setPrepare((c) => {
      c.issueUrl = (id) => `https://evil.example.com/issues/${id}`
    })
    await t.integration.ready
    await flush()
    await t.integration.issues()
    expect(() => t.integration.open(12)).toThrow(ExposedIpcError)
    expect(t.openExternal).not.toHaveBeenCalled()
  })
})

describe('redmine integration: privacy and lifecycle', () => {
  it('never logs the key, subjects, projects, the account or URLs', async () => {
    const t = setup()
    await t.integration.ready
    await flush()
    t.last().issues.mockRejectedValueOnce(new CodeReviewError('network'))
    await flush(REDMINE_TICK_MS)
    await t.integration.setKey(URL_B, 'SECRETKEY-other')
    await t.integration.issues()
    t.integration.open(12)
    await t.integration.updateIssue({ id: 12, statusId: 3 })
    await t.integration.clear()
    const log = JSON.stringify(t.logger.entries)
    expect(t.logger.entries.length).toBeGreaterThan(0)
    expect(log).not.toMatch(/SECRETKEY|Confidential|Hidden project|Alice|redmine\.example|other\.example/)
  })

  it('dispose stops every timer', async () => {
    const t = setup()
    await t.integration.ready
    await flush()
    t.integration.setViewOpen(true)
    await flush()
    const client = t.last()
    const calls = client.timeEntries.mock.calls.length
    t.integration.dispose()
    await flush(REDMINE_SUMMARY_TICK_MS * 4)
    expect(client.timeEntries).toHaveBeenCalledTimes(calls)
  })
})

describe('redmine integration: stale results are dropped', () => {
  const deferred = <T>() => {
    let resolve: (value: T) => void = () => undefined
    const promise = new Promise<T>((r) => (resolve = r))
    return { promise, resolve }
  }
  type T = ReturnType<typeof setup>
  /** Ways a session ends while a request is pending. */
  const endings: [string, (t: T) => Promise<void> | void][] = [
    ['clear()', (t) => t.integration.clear()],
    ['an external URL change', (t) => t.changeUrl(URL_B)],
    ['dispose()', (t) => t.integration.dispose()],
  ]

  it.each(endings)('a poll that resolves after %s publishes nothing', async (_, end) => {
    const t = setup()
    await t.integration.ready
    await flush()
    const client = t.last()
    const pending = deferred<{ issues: RedmineIssue[]; truncated: boolean }>()
    client.issues.mockReturnValueOnce(pending.promise)
    t.integration.refresh()
    await flush()
    await end(t)
    await flush()
    const emitted = t.emitted.length
    const before = t.integration.state()
    pending.resolve({ issues: [issue(99)], truncated: false })
    await flush()
    expect(t.emitted).toHaveLength(emitted)
    expect(t.integration.state()).toEqual(before)
  })

  it.each(endings)('a summary that resolves after %s is not kept or announced', async (_, end) => {
    const t = setup()
    await t.integration.ready
    await flush()
    const client = t.last()
    const pending = deferred<{ date: string; hours: number }[]>()
    client.timeEntries.mockImplementation((from, to) => (from === to ? Promise.resolve([]) : pending.promise))
    t.integration.setViewOpen(true)
    await flush()
    await end(t)
    await flush()
    const events = t.summaryEvents.length
    pending.resolve([{ date: '2026-11-14', hours: 3 }])
    await flush()
    expect(t.summaryEvents).toHaveLength(events)
    await expect(t.integration.summary()).resolves.toEqual({ summary: null, error: false })
  })

  it.each(endings)('a write that resolves after %s refreshes and publishes nothing', async (_, end) => {
    const t = setup()
    await t.integration.ready
    await flush()
    const client = t.last()
    const pending = deferred<RedmineWriteResult>()
    client.updateIssue.mockReturnValueOnce(pending.promise)
    const result = t.integration.updateIssue({ id: 12, statusId: 3 })
    await flush()
    await end(t)
    await flush()
    const issues = client.issues.mock.calls.length
    const emitted = t.emitted.length
    const before = t.integration.state()
    pending.resolve({ ok: true })
    await expect(result).resolves.toEqual({ ok: true })
    await flush()
    expect(client.issues).toHaveBeenCalledTimes(issues)
    expect(t.emitted).toHaveLength(emitted)
    expect(t.integration.state()).toEqual(before)
  })

  it.each(endings)('a key check that resolves after %s saves nothing', async (_, end) => {
    const t = setup()
    await t.integration.ready
    await flush()
    const pending = deferred<{ id: number; name: string }>()
    t.setPrepare((c) => c.viewer.mockReturnValueOnce(pending.promise))
    const result = t.integration.setKey(URL_A, 'late-key')
    await flush()
    await end(t)
    await flush()
    const emitted = t.emitted.length
    const before = t.integration.state()
    pending.resolve({ id: 7, name: 'Late' })
    await expect(result).resolves.toEqual({ ok: false, reason: 'network' })
    await flush()
    expect(t.tokenStore.save).not.toHaveBeenCalled()
    expect(t.stored.key).not.toBe('late-key')
    expect(t.emitted).toHaveLength(emitted)
    expect(t.integration.state()).toEqual(before)
    expect(t.integration.state().account).not.toBe('Late')
  })

  it.each(endings)('a read that resolves after %s is refused as UNAVAILABLE', async (_, end) => {
    const t = setup()
    await t.integration.ready
    await flush()
    const client = t.last()
    const detail = deferred<Awaited<ReturnType<RedmineClient['issue']>>>()
    const activities = deferred<Awaited<ReturnType<RedmineClient['activities']>>>()
    client.issue.mockReturnValueOnce(detail.promise)
    client.activities.mockReturnValueOnce(activities.promise)
    const pendingDetail = t.integration.issue(12)
    const pendingActivities = t.integration.activities()
    await flush()
    await end(t)
    detail.resolve({ ...issue(12), allowedStatuses: [] })
    activities.resolve([{ id: 9, name: 'Dev', isDefault: true }])
    await expect(pendingDetail).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(pendingActivities).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })
})
