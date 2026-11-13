import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeReviewError, type ClientItem, type CodeReviewClient, type CodeReviewSnapshot } from '../../../src/main/code-review/client-common'
import {
  CODE_REVIEW_BACKOFF_MS,
  CODE_REVIEW_CONTRIBUTIONS_TICK_MS,
  CODE_REVIEW_TICK_MS,
  createCodeReviewIntegration,
  parseCodeReviewBaseOverrides,
} from '../../../src/main/code-review/code-review-integration'
import { ExposedIpcError } from '../../../src/main/ipc/errors'
import { summarize, ZERO_TOTALS } from '../../../src/shared/code-review/contributions'
import type {
  CodeReviewAlert,
  CodeReviewState,
  ContributionsChanged,
  ContributionSummary,
  Platform,
  ReviewState,
} from '../../../src/shared/code-review/schema'
import type { CodeReviewSettings } from '../../../src/shared/settings/schema'
import { createMemoryLogger } from '../helpers/memory-logger'

const GITLAB = 'https://gitlab.example.com'
const TITLE = 'Secret feature title'

const item = (platform: Platform, id: string, review: ReviewState = 'none', extra: Partial<ClientItem> = {}): ClientItem => ({
  id,
  ref: platform === 'github' ? `acme/repo#${id}` : `grp/proj!${id}`,
  title: `${TITLE} ${id}`,
  author: 'someone',
  updatedAt: '2026-11-12T10:00:00.000Z',
  draft: false,
  review,
  checks: null,
  conflicts: false,
  url: platform === 'github' ? `https://github.com/acme/repo/pull/${id}` : `${GITLAB}/grp/proj/-/merge_requests/${id}`,
  ...extra,
})

/** Snapshot like the clients build it; `uncertain` ids are left out of `ownReview`. */
const snap = (mine: ClientItem[], toReview: ClientItem[] = [], uncertain: string[] = []): CodeReviewSnapshot => {
  const open = mine.filter((i) => !i.draft)
  return {
    toReview,
    mine,
    unreviewed: open.filter((i) => i.review === 'none').length,
    ownReview: open.filter((i) => !uncertain.includes(i.id)).map(({ id, review }) => ({ id, review })),
  }
}

interface FakeClient extends CodeReviewClient {
  viewer: ReturnType<typeof vi.fn<() => Promise<string>>>
  fetch: ReturnType<typeof vi.fn<() => Promise<CodeReviewSnapshot>>>
  contributions: ReturnType<typeof vi.fn<(now: Date) => Promise<ContributionSummary>>>
}

/** A summary like the clients build it for `now`'s month (`commits` contributions today). */
const summaryFor = (now: Date, commits = 1): ContributionSummary => {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const totals = { ...ZERO_TOTALS, commits }
  return summarize({ now, counts: new Map([[day, commits]]), today: totals, week: totals, monthTotals: totals, partial: false, restricted: false })
}

interface SetupOptions {
  tokens?: Partial<Record<Platform, string | null>>
  gitlabUrl?: string
  alerts?: boolean
  started?: boolean
  updateFails?: boolean
}

function setup(options: SetupOptions = {}) {
  vi.useFakeTimers({ now: new Date('2026-11-12T10:00:00.000Z') })
  const logger = createMemoryLogger()
  const alertsOn = options.alerts ?? true
  let current: { codeReview: CodeReviewSettings } = {
    codeReview: {
      gitlabUrl: options.gitlabUrl ?? GITLAB,
      alerts: { github: { enabled: alertsOn, sound: true }, gitlab: { enabled: alertsOn, sound: true } },
    },
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
    update: vi.fn(async (patch: { codeReview: CodeReviewSettings }) => {
      if (options.updateFails) throw new Error('disk full')
      current = { codeReview: patch.codeReview }
      notify()
      return current
    }),
  }
  const changeSettings = (codeReview: CodeReviewSettings) => {
    current = { codeReview }
    notify()
  }

  const stored: Record<Platform, string | null> = {
    github: options.tokens?.github === undefined ? 'gh-token-stored' : options.tokens.github,
    gitlab: options.tokens?.gitlab === undefined ? null : options.tokens.gitlab,
  }
  const makeStore = (platform: Platform) => ({
    load: vi.fn(async () => stored[platform]),
    save: vi.fn(async (token: string) => {
      stored[platform] = token
    }),
    clear: vi.fn(async () => {
      stored[platform] = null
    }),
    persistent: true,
  })
  const tokenStores = { github: makeStore('github'), gitlab: makeStore('gitlab') }

  const makeClient = (platform: Platform): FakeClient => ({
    viewer: vi.fn(async () => (platform === 'github' ? 'octo' : 'tanuki')),
    fetch: vi.fn(async () => snap([])),
    contributions: vi.fn(async (now: Date) => summaryFor(now)),
  })
  /** Every client created, with the token (and URL) it was built for. */
  const clients: { platform: Platform; token: string; baseUrl?: string; client: FakeClient }[] = []
  let prepare: (client: FakeClient, platform: Platform, token: string) => void = () => undefined
  const clientFactories = {
    github: vi.fn((token: string) => {
      const client = makeClient('github')
      prepare(client, 'github', token)
      clients.push({ platform: 'github', token, client })
      return client
    }),
    gitlab: vi.fn((baseUrl: string, token: string) => {
      const client = makeClient('gitlab')
      prepare(client, 'gitlab', token)
      clients.push({ platform: 'gitlab', token, baseUrl, client })
      return client
    }),
  }

  const emitted: CodeReviewState[] = []
  const contributionEvents: ContributionsChanged[] = []
  const alerts: CodeReviewAlert[] = []
  const openExternal = vi.fn(async () => undefined)
  const integration = createCodeReviewIntegration({
    settings,
    tokenStores,
    clientFactories,
    timers: { setTimeout, clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
    now: () => Date.now(),
    emit: (state) => emitted.push(state),
    emitContributions: (change) => contributionEvents.push(change),
    openExternal,
    onAlert: (alert) => alerts.push(alert),
    logger,
  })
  if (options.started ?? true) integration.start()

  const last = (platform: Platform) => {
    const found = [...clients].reverse().find((c) => c.platform === platform)
    if (!found) throw new Error(`no ${platform} client`)
    return found.client
  }
  return {
    integration,
    logger,
    settings,
    changeSettings,
    tokenStores,
    stored,
    clients,
    clientFactories,
    emitted,
    contributionEvents,
    alerts,
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

describe('code review integration: start and rhythm', () => {
  it('is unconfigured without a token and never builds a client', async () => {
    const t = setup({ tokens: { github: null } })
    await t.integration.ready
    await flush()
    expect(t.integration.state().github).toEqual({ status: 'unconfigured', account: null, unreviewed: null, updatedAt: null, persistent: true })
    expect(t.integration.state().gitlab.status).toBe('unconfigured')
    expect(t.clientFactories.github).not.toHaveBeenCalled()
    await flush(10 * 60_000)
    expect(t.clients).toHaveLength(0)
  })

  it('with a token queries at once, reports ok with account and count, then every 120 s', async () => {
    const t = setup()
    t.setPrepare((c) => c.fetch.mockResolvedValue(snap([item('github', '1'), item('github', '2', 'approved'), item('github', '3', 'none', { draft: true })])))
    await t.integration.ready
    await flush()
    const client = t.last('github')
    expect(client.fetch).toHaveBeenCalledTimes(1)
    expect(t.integration.state().github).toMatchObject({ status: 'ok', account: 'octo', unreviewed: 1, updatedAt: '2026-11-12T10:00:00.000Z' })
    await flush(CODE_REVIEW_TICK_MS - 1)
    expect(client.fetch).toHaveBeenCalledTimes(1)
    await flush(1)
    expect(client.fetch).toHaveBeenCalledTimes(2)
    expect(t.emitted.at(-1)?.github.status).toBe('ok')
  })

  it('does not query before start()', async () => {
    const t = setup({ started: false })
    await t.integration.ready
    await flush(CODE_REVIEW_TICK_MS * 2)
    expect(t.clients[0]?.client.fetch ?? vi.fn()).not.toHaveBeenCalled()
    t.integration.start()
    await flush()
    expect(t.last('github').fetch).toHaveBeenCalledTimes(1)
  })

  it('manual refresh queries at once, at most every 5 s', async () => {
    const t = setup()
    await t.integration.ready
    await flush()
    const client = t.last('github')
    t.integration.refresh()
    await flush()
    expect(client.fetch).toHaveBeenCalledTimes(2)
    t.integration.refresh()
    await flush(4_000)
    expect(client.fetch).toHaveBeenCalledTimes(2)
    t.integration.refresh()
    await flush(1_000)
    t.integration.refresh()
    await flush()
    expect(client.fetch).toHaveBeenCalledTimes(3)
  })

  it('failures go offline with growing waits (1, 2, 4, 5, 5 min) and keep the last data', async () => {
    const t = setup()
    t.setPrepare((c) => c.fetch.mockResolvedValueOnce(snap([item('github', '1')])))
    await t.integration.ready
    await flush()
    const client = t.last('github')
    client.fetch.mockRejectedValue(new CodeReviewError('network'))
    await t.integration.list('github')
    await flush(CODE_REVIEW_TICK_MS)
    expect(t.integration.state().github).toMatchObject({ status: 'offline', unreviewed: 1, updatedAt: '2026-11-12T10:00:00.000Z' })
    expect((await t.integration.list('github')).mine).toHaveLength(1)
    let calls = client.fetch.mock.calls.length
    for (const wait of [...CODE_REVIEW_BACKOFF_MS, CODE_REVIEW_BACKOFF_MS[3]]) {
      await flush(wait - 1)
      expect(client.fetch).toHaveBeenCalledTimes(calls)
      await flush(1)
      expect(client.fetch).toHaveBeenCalledTimes(++calls)
    }
    client.fetch.mockResolvedValue(snap([]))
    await flush(CODE_REVIEW_BACKOFF_MS[3])
    expect(t.integration.state().github).toMatchObject({ status: 'ok', unreviewed: 0 })
    await flush(CODE_REVIEW_TICK_MS)
    expect(client.fetch).toHaveBeenCalledTimes(calls + 2)
  })

  it('401/403 (auth) turns auth-error and stops querying that platform only', async () => {
    const t = setup({ tokens: { gitlab: 'gl-token' } })
    t.setPrepare((c, platform) => {
      if (platform === 'github') c.fetch.mockRejectedValue(new CodeReviewError('auth'))
    })
    await t.integration.ready
    await flush()
    expect(t.integration.state().github).toMatchObject({ status: 'auth-error', unreviewed: null })
    expect(t.integration.state().gitlab.status).toBe('ok')
    await flush(CODE_REVIEW_TICK_MS * 5)
    expect(t.last('github').fetch).toHaveBeenCalledTimes(1)
    expect(t.last('gitlab').fetch).toHaveBeenCalledTimes(6)
    t.integration.refresh()
    await flush()
    expect(t.last('github').fetch).toHaveBeenCalledTimes(1)
    expect(await t.integration.list('github')).toEqual({ toReview: [], mine: [] })
  })

  it('a GitLab token without a configured URL belongs to nobody: cleared, unconfigured', async () => {
    const t = setup({ gitlabUrl: '', tokens: { gitlab: 'gl-orphan' } })
    await t.integration.ready
    expect(t.integration.state().gitlab.status).toBe('unconfigured')
    expect(t.tokenStores.gitlab.clear).toHaveBeenCalled()
    expect(t.clientFactories.gitlab).not.toHaveBeenCalled()
  })

  it('builds the GitLab client with the configured URL', async () => {
    const t = setup({ tokens: { gitlab: 'gl-token' } })
    await t.integration.ready
    expect(t.clientFactories.gitlab).toHaveBeenCalledWith(GITLAB, 'gl-token')
  })
})

describe('code review integration: setToken and clear', () => {
  it('validates with viewer() before saving, then queries', async () => {
    const t = setup({ tokens: { github: null } })
    await t.integration.ready
    await expect(t.integration.setToken('github', ' ghp_new ')).resolves.toEqual({ ok: true, account: 'octo' })
    expect(t.clientFactories.github).toHaveBeenCalledWith('ghp_new')
    expect(t.tokenStores.github.save).toHaveBeenCalledWith('ghp_new')
    await flush()
    expect(t.integration.state().github).toMatchObject({ status: 'ok', account: 'octo', unreviewed: 0 })
    expect(t.last('github').fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['auth', 'auth'],
    ['network', 'network'],
    ['server', 'network'],
    ['rate-limited', 'network'],
  ] as const)('a %s failure answers %s and saves nothing', async (code, reason) => {
    const t = setup({ tokens: { github: null } })
    t.setPrepare((c) => c.viewer.mockRejectedValue(new CodeReviewError(code)))
    await t.integration.ready
    await expect(t.integration.setToken('github', 'ghp_bad')).resolves.toEqual({ ok: false, reason })
    expect(t.tokenStores.github.save).not.toHaveBeenCalled()
    expect(t.integration.state().github.status).toBe('unconfigured')
  })

  it('a failed new token leaves a working one untouched', async () => {
    const t = setup()
    await t.integration.ready
    await flush()
    const working = t.last('github')
    t.setPrepare((c) => c.viewer.mockRejectedValue(new CodeReviewError('auth')))
    await expect(t.integration.setToken('github', 'ghp_bad')).resolves.toEqual({ ok: false, reason: 'auth' })
    expect(t.integration.state().github.status).toBe('ok')
    await flush(CODE_REVIEW_TICK_MS)
    expect(working.fetch).toHaveBeenCalledTimes(2)
  })

  it('GitLab: refuses a non-https URL with reason url; saves the normalized URL in settings', async () => {
    const t = setup({ gitlabUrl: '' })
    await t.integration.ready
    t.tokenStores.gitlab.clear.mockClear() // the startup clear of an orphan token
    await expect(t.integration.setToken('gitlab', 'glpat', 'http://gitlab.example.com')).resolves.toEqual({ ok: false, reason: 'url' })
    await expect(t.integration.setToken('gitlab', 'glpat')).resolves.toEqual({ ok: false, reason: 'url' })
    expect(t.clientFactories.gitlab).not.toHaveBeenCalled()
    await expect(t.integration.setToken('gitlab', 'glpat', ' https://git.example.org/base/ ')).resolves.toEqual({ ok: true, account: 'tanuki' })
    expect(t.clientFactories.gitlab).toHaveBeenCalledWith('https://git.example.org/base', 'glpat')
    expect(t.settings.get().codeReview.gitlabUrl).toBe('https://git.example.org/base')
    expect(t.stored.gitlab).toBe('glpat')
    await flush()
    expect(t.integration.state().gitlab.status).toBe('ok')
    // Its own settings write does not count as an outside URL change.
    expect(t.tokenStores.gitlab.clear).not.toHaveBeenCalled()
  })

  it('GitLab: an invalid response from the server (not GitLab) is reason url', async () => {
    const t = setup()
    t.setPrepare((c) => c.viewer.mockRejectedValue(new CodeReviewError('invalid-response')))
    await t.integration.ready
    await expect(t.integration.setToken('gitlab', 'glpat', 'https://not-gitlab.example.com')).resolves.toEqual({ ok: false, reason: 'url' })
    expect(t.settings.update).not.toHaveBeenCalled()
  })

  it('GitLab: when the URL cannot be saved, the new token is refused and the current session stays', async () => {
    const t = setup({ updateFails: true, tokens: { gitlab: 'gl-old' } })
    await t.integration.ready
    await flush()
    await expect(t.integration.setToken('gitlab', 'gl-new', 'https://other.example.com')).resolves.toEqual({ ok: false, reason: 'network' })
    expect(t.tokenStores.gitlab.save).not.toHaveBeenCalled()
    expect(t.stored.gitlab).toBe('gl-old')
    expect(t.integration.state().gitlab.status).toBe('ok')
  })

  it('GitLab: after a failed URL save, an unrelated settings change wipes nothing', async () => {
    const t = setup({ updateFails: true, tokens: { gitlab: 'gl-old' } })
    await t.integration.ready
    await flush()
    await t.integration.setToken('gitlab', 'gl-new', 'https://other.example.com')
    t.tokenStores.gitlab.clear.mockClear()
    const codeReview = t.settings.get().codeReview
    t.changeSettings({ ...codeReview, alerts: { ...codeReview.alerts, github: { enabled: false, sound: false } } })
    await flush()
    expect(t.tokenStores.gitlab.clear).not.toHaveBeenCalled()
    expect(t.stored.gitlab).toBe('gl-old')
    expect(t.integration.state().gitlab.status).toBe('ok')
  })

  it('a new token resets the detector and drops results of the old generation', async () => {
    const t = setup()
    let release: (s: CodeReviewSnapshot) => void = () => undefined
    t.setPrepare((c, _p, token) => {
      if (token === 'gh-token-stored') {
        c.fetch.mockResolvedValueOnce(snap([item('github', '1')]))
        c.fetch.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
      }
    })
    await t.integration.ready
    await flush()
    t.integration.refresh()
    await flush()
    // A token change while the old query is in flight.
    t.setPrepare((c) => c.fetch.mockResolvedValue(snap([item('github', '1', 'approved')])))
    await t.integration.setToken('github', 'ghp_other')
    await flush()
    release(snap([item('github', '1', 'approved'), item('github', '9')]))
    await flush()
    expect(t.integration.state().github.unreviewed).toBe(0)
    // A baseline again: '1' was none for the old token, approved for the new one, yet no alert.
    expect(t.alerts).toEqual([])
    // GitLab is untouched by a GitHub token change.
    expect(t.clientFactories.gitlab).not.toHaveBeenCalled()
  })

  it('an outside change of the GitLab URL closes the session and drops the token', async () => {
    const t = setup({ tokens: { gitlab: 'gl-token' } })
    await t.integration.ready
    await flush()
    const before = t.last('gitlab')
    t.changeSettings({ ...t.settings.get().codeReview, gitlabUrl: 'https://elsewhere.example.com' })
    await flush()
    expect(t.integration.state().gitlab.status).toBe('unconfigured')
    expect(t.stored.gitlab).toBeNull()
    await flush(CODE_REVIEW_TICK_MS * 2)
    expect(before.fetch).toHaveBeenCalledTimes(1)
    expect(t.integration.state().github.status).toBe('ok')
  })

  it('clear removes the token and the state, and stops querying', async () => {
    const t = setup()
    t.setPrepare((c) => c.fetch.mockResolvedValue(snap([item('github', '1')])))
    await t.integration.ready
    await flush()
    await t.integration.list('github')
    await t.integration.clear('github')
    expect(t.stored.github).toBeNull()
    expect(t.integration.state().github).toEqual({ status: 'unconfigured', account: null, unreviewed: null, updatedAt: null, persistent: true })
    expect(await t.integration.list('github')).toEqual({ toReview: [], mine: [] })
    expect(() => t.integration.open('github', '1')).toThrow(ExposedIpcError)
    await flush(CODE_REVIEW_TICK_MS * 2)
    expect(t.last('github').fetch).toHaveBeenCalledTimes(1)
  })
})

describe('code review integration: alerts', () => {
  const reviewRound = async (alerts: boolean) => {
    const t = setup({ alerts })
    t.setPrepare((c) => {
      c.fetch.mockResolvedValueOnce(snap([item('github', '1'), item('github', '2')]))
      c.fetch.mockResolvedValue(snap([item('github', '1', 'approved'), item('github', '2')]))
    })
    await t.integration.ready
    await flush()
    await flush(CODE_REVIEW_TICK_MS)
    return t
  }

  it('one first review: alert with kind, ref and title', async () => {
    const t = await reviewRound(true)
    expect(t.alerts).toEqual([{ platform: 'github', count: 1, kind: 'approved', ref: 'acme/repo#1', title: `${TITLE} 1` }])
    expect(t.integration.state().github.unreviewed).toBe(1)
  })

  it('no alert with alerts disabled', async () => {
    const t = await reviewRound(false)
    expect(t.alerts).toEqual([])
  })

  it('several at once: only the count', async () => {
    const t = setup()
    t.setPrepare((c) => {
      c.fetch.mockResolvedValueOnce(snap([item('github', '1'), item('github', '2')]))
      c.fetch.mockResolvedValue(snap([item('github', '1', 'changes'), item('github', '2', 'commented')]))
    })
    await t.integration.ready
    await flush()
    await flush(CODE_REVIEW_TICK_MS)
    expect(t.alerts).toEqual([{ platform: 'github', count: 2 }])
  })

  it('GitLab: an MR reviewed during a transient per-MR failure still alerts once the data returns', async () => {
    const t = setup({ tokens: { github: null, gitlab: 'gl-token' } })
    const a = item('gitlab', '7')
    t.setPrepare((c) => {
      c.fetch.mockResolvedValueOnce(snap([a, item('gitlab', '8')]))
      // Reviewed meanwhile, but the per-MR calls failed: degraded to 'none', uncertain.
      c.fetch.mockResolvedValueOnce(snap([{ ...a, review: 'none' }, item('gitlab', '8')], [], ['7']))
      c.fetch.mockResolvedValue(snap([{ ...a, review: 'approved' }, item('gitlab', '8')]))
    })
    await t.integration.ready
    await flush()
    await flush(CODE_REVIEW_TICK_MS)
    expect(t.alerts).toEqual([])
    await flush(CODE_REVIEW_TICK_MS)
    expect(t.alerts).toEqual([{ platform: 'gitlab', count: 1, kind: 'approved', ref: 'grp/proj!7', title: `${TITLE} 7` }])
  })

  it('GitLab: an uncertain MR keeps its previous state in the count (no jump)', async () => {
    const t = setup({ tokens: { github: null, gitlab: 'gl-token' } })
    t.setPrepare((c) => {
      // Round 1: 7 approved, 8 unreviewed -> 1.
      c.fetch.mockResolvedValueOnce(snap([item('gitlab', '7', 'approved'), item('gitlab', '8')]))
      // Round 2: 7's calls fail and it degrades to 'none' -> the client counts 2; the integration keeps 1.
      c.fetch.mockResolvedValueOnce(snap([item('gitlab', '7'), item('gitlab', '8')], [], ['7']))
      // Round 3: an unknown MR (never seen) is uncertain: left out of the count.
      c.fetch.mockResolvedValueOnce(snap([item('gitlab', '7', 'approved'), item('gitlab', '8'), item('gitlab', '9')], [], ['9']))
      c.fetch.mockResolvedValue(snap([item('gitlab', '7', 'approved'), item('gitlab', '8'), item('gitlab', '9', 'approved')]))
    })
    await t.integration.ready
    await flush()
    expect(t.integration.state().gitlab.unreviewed).toBe(1)
    await flush(CODE_REVIEW_TICK_MS)
    expect(t.integration.state().gitlab.unreviewed).toBe(1)
    await flush(CODE_REVIEW_TICK_MS)
    expect(t.integration.state().gitlab.unreviewed).toBe(1)
    await flush(CODE_REVIEW_TICK_MS)
    expect(t.integration.state().gitlab.unreviewed).toBe(1)
    // 9 was never known as 'none': appearing reviewed is no first review.
    expect(t.alerts).toEqual([])
  })
})

describe('code review integration: list and open', () => {
  it('lists without URLs and opens only ids of the last list on allowed origins', async () => {
    const t = setup({ tokens: { gitlab: 'gl-token' } })
    t.setPrepare((c, platform) => {
      if (platform === 'github') {
        c.fetch.mockResolvedValue(
          snap([item('github', '1'), item('github', '2', 'none', { url: 'https://evil.example.com/x' })], [item('github', '3', 'none', { url: 'http://github.com/a' })]),
        )
      } else {
        c.fetch.mockResolvedValue(snap([item('gitlab', '5'), item('gitlab', '6', 'none', { url: 'https://github.com/x' })]))
      }
    })
    await t.integration.ready
    await flush()
    expect(() => t.integration.open('github', '1')).toThrow(ExposedIpcError) // not listed yet
    const list = await t.integration.list('github')
    expect(list.mine.map((i) => i.id)).toEqual(['1', '2'])
    expect(JSON.stringify(list)).not.toContain('https://')
    t.integration.open('github', '1')
    await flush()
    expect(t.openExternal).toHaveBeenCalledWith('https://github.com/acme/repo/pull/1')
    expect(() => t.integration.open('github', '2')).toThrow(ExposedIpcError)
    expect(() => t.integration.open('github', '3')).toThrow(ExposedIpcError)
    expect(() => t.integration.open('gitlab', '5')).toThrow(ExposedIpcError) // the gitlab list was never sent
    await t.integration.list('gitlab')
    t.integration.open('gitlab', '5')
    await flush()
    expect(t.openExternal).toHaveBeenLastCalledWith(`${GITLAB}/grp/proj/-/merge_requests/5`)
    expect(() => t.integration.open('gitlab', '6')).toThrow(ExposedIpcError)
    expect(() => t.integration.open('gitlab', '1')).toThrow(ExposedIpcError)
    expect(t.openExternal).toHaveBeenCalledTimes(2)
  })
})

describe('code review integration: privacy', () => {
  it('never logs tokens, titles, refs or authors', async () => {
    const t = setup({ tokens: { gitlab: 'glpat-SECRETTOKEN' } })
    t.setPrepare((c, platform) => {
      c.fetch.mockResolvedValueOnce(snap([item(platform, '1')]))
      c.fetch.mockResolvedValueOnce(snap([item(platform, '1', 'approved')]))
      c.fetch.mockRejectedValue(new CodeReviewError('server'))
    })
    await t.integration.ready
    await flush()
    await flush(CODE_REVIEW_TICK_MS * 3)
    await t.integration.setToken('github', 'ghp_SECRETTOKEN')
    await t.integration.list('github')
    try {
      t.integration.open('github', 'nope')
    } catch {
      // refused
    }
    await t.integration.clear('gitlab')
    const log = JSON.stringify(t.logger.entries)
    expect(t.logger.entries.length).toBeGreaterThan(0)
    expect(log).not.toMatch(/SECRET|gh-token-stored|acme|grp\/proj|someone|octo|tanuki/)
  })
})

describe('code review integration: contributions', () => {
  const both = { tokens: { gitlab: 'gl-token' } }

  it('never queries contributions while the view is closed', async () => {
    const t = setup(both)
    await t.integration.ready
    await flush(CODE_REVIEW_CONTRIBUTIONS_TICK_MS * 3)
    t.integration.refresh()
    await flush()
    expect(t.last('github').contributions).not.toHaveBeenCalled()
    expect(t.last('gitlab').contributions).not.toHaveBeenCalled()
    expect((await t.integration.contributions('github')).summary).toBeNull()
  })

  it('queries each connected platform on open, then every 15 min while open; stops on close', async () => {
    const t = setup(both)
    await t.integration.ready
    await flush()
    t.integration.setViewOpen(true)
    await flush()
    const gh = t.last('github')
    const gl = t.last('gitlab')
    expect(gh.contributions).toHaveBeenCalledTimes(1)
    expect(gl.contributions).toHaveBeenCalledTimes(1)
    expect((await t.integration.contributions('github')).summary?.month).toBe('2026-11')
    expect(t.contributionEvents).toEqual(expect.arrayContaining([{ platform: 'github', error: false }, { platform: 'gitlab', error: false }]))
    await flush(CODE_REVIEW_CONTRIBUTIONS_TICK_MS - 1)
    expect(gh.contributions).toHaveBeenCalledTimes(1)
    await flush(1)
    expect(gh.contributions).toHaveBeenCalledTimes(2)
    expect(gl.contributions).toHaveBeenCalledTimes(2)
    t.integration.setViewOpen(false)
    await flush(CODE_REVIEW_CONTRIBUTIONS_TICK_MS * 4)
    expect(gh.contributions).toHaveBeenCalledTimes(2)
    // The cache outlives the closed view (shown at once on the next open, then refreshed).
    expect((await t.integration.contributions('github')).summary).not.toBeNull()
    t.integration.setViewOpen(true)
    await flush()
    expect(gh.contributions).toHaveBeenCalledTimes(3)
  })

  it('opening twice in a row does not start a second timer or query', async () => {
    const t = setup()
    await t.integration.ready
    await flush()
    t.integration.setViewOpen(true)
    t.integration.setViewOpen(true)
    await flush()
    expect(t.last('github').contributions).toHaveBeenCalledTimes(1)
    await flush(CODE_REVIEW_CONTRIBUTIONS_TICK_MS)
    expect(t.last('github').contributions).toHaveBeenCalledTimes(2)
  })

  it('skips unconfigured and auth-error platforms', async () => {
    const t = setup({ tokens: { github: null, gitlab: 'gl-token' } })
    t.setPrepare((c) => c.fetch.mockRejectedValue(new CodeReviewError('auth')))
    await t.integration.ready
    await flush()
    t.integration.setViewOpen(true)
    await flush(CODE_REVIEW_CONTRIBUTIONS_TICK_MS)
    expect(t.last('gitlab').contributions).not.toHaveBeenCalled()
    expect((await t.integration.contributions('github')).summary).toBeNull()
    expect((await t.integration.contributions('gitlab')).summary).toBeNull()
  })

  it('manual refresh also refreshes contributions while open, sharing the 5 s minimum', async () => {
    const t = setup()
    await t.integration.ready
    await flush()
    t.integration.setViewOpen(true)
    await flush()
    const gh = t.last('github')
    expect(gh.contributions).toHaveBeenCalledTimes(1)
    await flush(5_000)
    t.integration.refresh()
    await flush()
    expect(gh.contributions).toHaveBeenCalledTimes(2)
    expect(gh.fetch).toHaveBeenCalledTimes(2)
    t.integration.refresh()
    await flush(4_000)
    expect(gh.contributions).toHaveBeenCalledTimes(2)
    // The 15 min rhythm restarts from the manual query.
    await flush(CODE_REVIEW_CONTRIBUTIONS_TICK_MS - 4_000 - 1)
    expect(gh.contributions).toHaveBeenCalledTimes(2)
    await flush(1)
    expect(gh.contributions).toHaveBeenCalledTimes(3)
  })

  it('a failure keeps the cache, flags the error and leaves lists and state alone; success clears the flag', async () => {
    const t = setup()
    t.setPrepare((c) => c.fetch.mockResolvedValue(snap([item('github', '1')])))
    await t.integration.ready
    await flush()
    t.integration.setViewOpen(true)
    await flush()
    const gh = t.last('github')
    const cached = (await t.integration.contributions('github')).summary
    expect(cached).not.toBeNull()
    const statesBefore = t.emitted.length
    gh.contributions.mockRejectedValueOnce(new CodeReviewError('network'))
    await flush(CODE_REVIEW_CONTRIBUTIONS_TICK_MS)
    expect(t.contributionEvents.at(-1)).toEqual({ platform: 'github', error: true })
    // A view that mounts now (reload, reopen) reads the error without waiting for the next event.
    expect(await t.integration.contributions('github')).toEqual({ summary: cached, error: true })
    expect(t.integration.state().github).toMatchObject({ status: 'ok', unreviewed: 1 })
    expect((await t.integration.list('github')).mine).toHaveLength(1)
    expect(t.emitted.slice(statesBefore).every((s) => s.github.status === 'ok')).toBe(true)
    // A failed retry still ends with an event (the view stops its spinner).
    const events = t.contributionEvents.length
    gh.contributions.mockRejectedValueOnce(new CodeReviewError('server'))
    t.integration.refresh()
    await flush()
    expect(t.contributionEvents.length).toBe(events + 1)
    expect(t.contributionEvents.at(-1)).toEqual({ platform: 'github', error: true })
    await flush(5_000)
    t.integration.refresh()
    await flush()
    expect(t.contributionEvents.at(-1)).toEqual({ platform: 'github', error: false })
    expect((await t.integration.contributions('github')).error).toBe(false)
  })

  it('401/403 on contributions goes to auth-error like the lists and stops both', async () => {
    const t = setup(both)
    await t.integration.ready
    await flush()
    const gh = t.last('github')
    gh.contributions.mockRejectedValue(new CodeReviewError('auth'))
    t.integration.setViewOpen(true)
    await flush()
    expect(t.integration.state().github).toMatchObject({ status: 'auth-error', unreviewed: null })
    expect(t.integration.state().gitlab.status).toBe('ok')
    // The retry ends with an error event; the state's auth-error decides what the view shows.
    expect(t.contributionEvents.filter((e) => e.platform === 'github').at(-1)).toEqual({ platform: 'github', error: true })
    expect(await t.integration.contributions('github')).toEqual({ summary: null, error: false })
    expect(await t.integration.list('github')).toEqual({ toReview: [], mine: [] })
    const fetches = gh.fetch.mock.calls.length
    await flush(CODE_REVIEW_CONTRIBUTIONS_TICK_MS * 2)
    expect(gh.contributions).toHaveBeenCalledTimes(1)
    expect(gh.fetch).toHaveBeenCalledTimes(fetches)
    expect(t.last('gitlab').contributions).toHaveBeenCalledTimes(3)
  })

  it('a list query that ends after a contributions 401 does not revive the platform', async () => {
    const t = setup()
    await t.integration.ready
    await flush()
    const gh = t.last('github')
    let releaseList: (s: CodeReviewSnapshot) => void = () => undefined
    gh.fetch.mockImplementationOnce(() => new Promise((resolve) => (releaseList = resolve)))
    gh.contributions.mockRejectedValue(new CodeReviewError('auth'))
    await flush(CODE_REVIEW_TICK_MS)
    expect(gh.fetch).toHaveBeenCalledTimes(2)
    t.integration.setViewOpen(true)
    await flush()
    expect(t.integration.state().github.status).toBe('auth-error')
    releaseList(snap([item('github', '1')]))
    await flush(CODE_REVIEW_TICK_MS * 2)
    expect(t.integration.state().github).toMatchObject({ status: 'auth-error', unreviewed: null })
    expect(gh.fetch).toHaveBeenCalledTimes(2)
  })

  it('a new token starts a new generation: empty cache, old results dropped, new query while open', async () => {
    const t = setup()
    await t.integration.ready
    await flush()
    t.integration.setViewOpen(true)
    await flush()
    const old = t.last('github')
    expect((await t.integration.contributions('github')).summary).not.toBeNull()
    let release: (s: ContributionSummary) => void = () => undefined
    old.contributions.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    await flush(CODE_REVIEW_CONTRIBUTIONS_TICK_MS)
    expect(old.contributions).toHaveBeenCalledTimes(2)
    let releaseNew: (s: ContributionSummary) => void = () => undefined
    t.setPrepare((c) => c.contributions.mockImplementationOnce(() => new Promise((resolve) => (releaseNew = resolve))))
    await t.integration.setToken('github', 'gh-new')
    expect((await t.integration.contributions('github')).summary).toBeNull()
    expect(t.contributionEvents.at(-1)).toEqual({ platform: 'github', error: false })
    release(summaryFor(new Date(), 99))
    await flush()
    expect((await t.integration.contributions('github')).summary).toBeNull()
    const fresh = t.last('github')
    expect(fresh).not.toBe(old)
    expect(fresh.contributions).toHaveBeenCalledTimes(1)
    releaseNew(summaryFor(new Date(), 2))
    await flush()
    expect((await t.integration.contributions('github')).summary?.monthTotal).toBe(2)
    await t.integration.clear('github')
    expect((await t.integration.contributions('github')).summary).toBeNull()
  })

  it('computes the range from the clock on each query: crossing midnight and the month end', async () => {
    const t = setup()
    vi.setSystemTime(new Date(2026, 10, 30, 23, 50))
    await t.integration.ready
    await flush()
    t.integration.setViewOpen(true)
    await flush()
    const gh = t.last('github')
    expect(gh.contributions.mock.calls[0]?.[0].getTime()).toBe(new Date(2026, 10, 30, 23, 50).getTime())
    expect((await t.integration.contributions('github')).summary?.month).toBe('2026-11')
    await flush(CODE_REVIEW_CONTRIBUTIONS_TICK_MS)
    const second = gh.contributions.mock.calls[1]?.[0]
    expect(second?.getMonth()).toBe(11)
    expect(second?.getDate()).toBe(1)
    const summary = (await t.integration.contributions('github')).summary
    expect(summary?.month).toBe('2026-12')
    expect(summary?.today.commits).toBe(1)
  })

  it('stops the contributions timer on dispose', async () => {
    const t = setup()
    await t.integration.ready
    await flush()
    t.integration.setViewOpen(true)
    await flush()
    t.integration.dispose()
    await flush(CODE_REVIEW_CONTRIBUTIONS_TICK_MS * 2)
    expect(t.last('github').contributions).toHaveBeenCalledTimes(1)
  })

  it('logs only platforms and codes', async () => {
    const t = setup(both)
    await t.integration.ready
    await flush()
    t.last('github').contributions.mockRejectedValueOnce(new CodeReviewError('network'))
    t.integration.setViewOpen(true)
    await flush(CODE_REVIEW_CONTRIBUTIONS_TICK_MS)
    const log = JSON.stringify(t.logger.entries)
    expect(log).toContain('network')
    expect(log).not.toMatch(/acme|grp\/proj|someone|octo|tanuki|gh-token-stored|gl-token/)
  })
})

describe('parseCodeReviewBaseOverrides', () => {
  it('accepts only loopback http origins with a port, per platform', () => {
    expect(parseCodeReviewBaseOverrides(undefined)).toEqual({})
    expect(parseCodeReviewBaseOverrides('github=http://127.0.0.1:1234,gitlab=http://127.0.0.1:5678')).toEqual({
      github: 'http://127.0.0.1:1234',
      gitlab: 'http://127.0.0.1:5678',
    })
    expect(parseCodeReviewBaseOverrides('gitlab=http://127.0.0.1:5678')).toEqual({ gitlab: 'http://127.0.0.1:5678' })
    for (const bad of [
      'github=https://api.github.com',
      'github=http://localhost:1234',
      'github=http://127.0.0.1',
      'github=http://127.0.0.1:1234/path',
      'github=http://127.0.0.1:99999',
      'other=http://127.0.0.1:1234',
      'github=http://127.0.0.1:1234,gitlab=http://evil.example.com:80',
      'nonsense',
    ]) {
      expect(parseCodeReviewBaseOverrides(bad)).toEqual({})
    }
  })
})
