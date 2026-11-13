import {
  CODE_REVIEW_COUNT_CAP,
  gitlabUrlSchema,
  type CodeReviewAlert,
  type CodeReviewList,
  type CodeReviewState,
  type ContributionsChanged,
  type ContributionsResult,
  type ContributionSummary,
  type Platform,
  type PlatformState,
  type PlatformStatus,
  type ReviewKind,
  type ReviewState,
  type SetTokenResult,
} from '../../shared/code-review/schema'
import type { CodeReviewSettings } from '../../shared/settings/schema'
import { ExposedIpcError } from '../ipc/errors'
import type { Logger } from '../services/logger'
import type { TokenStore } from '../services/secure-token-store'
import { CodeReviewError, toReviewItem, type ClientItem, type CodeReviewClient } from './client-common'
import { createReviewDetector, type ReviewDetector } from './review-detector'

/** Query rhythm, in every notch mode (first-review alerts show over mini and hidden too). */
export const CODE_REVIEW_TICK_MS = 120_000
/** Waits after consecutive network / 5xx / 429 / invalid-response failures: 1 → 2 → 4 → 5 min (max). */
export const CODE_REVIEW_BACKOFF_MS = [60_000, 120_000, 240_000, 300_000] as const
/** Contributions rhythm, only while the "Revisiones" view is open. */
export const CODE_REVIEW_CONTRIBUTIONS_TICK_MS = 900_000
/** Minimum time between two manual refreshes. */
export const CODE_REVIEW_MANUAL_REFRESH_MIN_MS = 5_000
/** The only origin GitHub items may open in the browser. */
export const GITHUB_WEB_ORIGIN = 'https://github.com'

const PLATFORMS: readonly Platform[] = ['github', 'gitlab']

const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/

/**
 * Dev/E2E switch `NOTCH_CODE_REVIEW_BASE_URLS` (`github=http://127.0.0.1:1234,gitlab=http://127.0.0.1:1234`):
 * each value must be an exact `http://127.0.0.1:<port>` origin. Anything malformed turns the whole switch off.
 */
export function parseCodeReviewBaseOverrides(raw: string | undefined): Partial<Record<Platform, string>> {
  if (raw === undefined || raw.trim() === '') return {}
  const result: Partial<Record<Platform, string>> = {}
  for (const part of raw.split(',')) {
    const separator = part.indexOf('=')
    if (separator < 0) return {}
    const key = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (key !== 'github' && key !== 'gitlab') return {}
    const match = LOOPBACK_ORIGIN.exec(value)
    const port = match ? Number(match[1]) : 0
    if (!match || port < 1 || port > 65_535) return {}
    result[key] = value
  }
  return result
}

export interface CodeReviewTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface CodeReviewSettingsSource {
  get(): { readonly codeReview: CodeReviewSettings }
  onChange(listener: (settings: { readonly codeReview: CodeReviewSettings }) => void): () => void
  /** Saves the GitLab URL after a token passed validation (through the settings updater). */
  update(patch: { codeReview: CodeReviewSettings }): Promise<unknown>
}

export interface CodeReviewClientFactories {
  github: (token: string) => CodeReviewClient
  /** `baseUrl` is the normalized https URL from settings; may throw if it is not acceptable. */
  gitlab: (baseUrl: string, token: string) => CodeReviewClient
}

export interface CodeReviewIntegrationOptions {
  settings: CodeReviewSettingsSource
  tokenStores: Record<Platform, Pick<TokenStore, 'load' | 'save' | 'clear' | 'persistent'>>
  clientFactories: CodeReviewClientFactories
  timers: CodeReviewTimers
  now: () => number
  /** Pushes `code-review:state` to the notch and the Control Center. */
  emit: (state: CodeReviewState) => void
  /** Pushes `code-review:contributions-changed` to the notch (summary replaced or cleared, or a query ended). */
  emitContributions?: (change: ContributionsChanged) => void
  openExternal: (url: string) => Promise<void> | void
  /** Own PR/MRs got their first review while that platform's alerts are on. */
  onAlert?: (alert: CodeReviewAlert) => void
  logger: Logger
}

export interface CodeReviewIntegration {
  /** Resolves once both stored tokens were read (never rejects). */
  readonly ready: Promise<void>
  state(): CodeReviewState
  /** The last lists of a platform (no URLs); remembered as the ids `open` accepts. */
  list(platform: Platform): Promise<CodeReviewList>
  /** Queries every connected platform now (at most every 5 s); contributions too while the view is open. */
  refresh(): void
  /** The "Revisiones" view opened or closed: contributions are queried on open and every 15 min while open. */
  setViewOpen(open: boolean): void
  /** The cached month summary of a platform (null when not connected or not loaded yet) and the last query's error; never queries. */
  contributions(platform: Platform): Promise<ContributionsResult>
  /** Opens an item of the last list sent, only on its platform's allowed origin; else ExposedIpcError. */
  open(platform: Platform, id: string): void
  /** Validates the token (and GitLab URL) against the API before saving anything. */
  setToken(platform: Platform, token: string, url?: string): Promise<SetTokenResult>
  clear(platform: Platform): Promise<void>
  /** Starts the rhythm (main calls it once the IPC targets exist). */
  start(): void
  dispose(): void
}

interface Runtime {
  readonly platform: Platform
  token: string | null
  client: CodeReviewClient | null
  status: PlatformStatus
  account: string | null
  unreviewed: number | null
  updatedAt: string | null
  toReview: ClientItem[]
  mine: ClientItem[]
  /** Id → URL of the last list handed to the notch: `open` only accepts these. */
  sent: Map<string, string>
  readonly detector: ReviewDetector
  /** Last known review state of each own open PR/MR (kept for items uncertain in a round). */
  remembered: Map<string, ReviewState>
  /** Bumped whenever the token, URL or session changes: stale results are dropped. */
  generation: number
  /** Bumped by every setToken/clear: an older validation that finishes later changes nothing. */
  tokenSeq: number
  timer: unknown
  failures: number
  inFlight: { generation: number; run: Promise<void> } | null
  /** A token save in progress; a clear waits for it so the token never outlives a removal. */
  pendingSave: Promise<void>
  loggedStatus: PlatformStatus | null
  /** Last contributions summary of this generation (memory only). */
  contributions: ContributionSummary | null
  /** The last contributions query failed (the cached summary is kept). */
  contributionsError: boolean
  contributionsTimer: unknown
  contributionsInFlight: { generation: number; run: Promise<void> } | null
}

/** Only a code or an error name: messages could quote tokens or titles. */
const errorCode = (error: unknown): string => {
  if (error instanceof CodeReviewError) return error.code
  return error instanceof Error ? error.name : typeof error
}

const originOf = (url: string): string | null => {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' ? parsed.origin : null
  } catch {
    return null
  }
}

/**
 * GitHub and GitLab state machine for main: one independent runtime per platform (token, client,
 * generation, rhythm, backoff, first-review detector). Logs only platforms, states, counts and codes.
 */
export function createCodeReviewIntegration(options: CodeReviewIntegrationOptions): CodeReviewIntegration {
  const { tokenStores, timers, now } = options
  const log = options.logger.child('code-review')

  let gitlabUrl = options.settings.get().codeReview.gitlabUrl
  let started = false
  let disposed = false
  let lastManualRefresh = Number.NEGATIVE_INFINITY
  let viewOpen = false

  const makeRuntime = (platform: Platform): Runtime => ({
    platform,
    token: null,
    client: null,
    status: 'unconfigured',
    account: null,
    unreviewed: null,
    updatedAt: null,
    toReview: [],
    mine: [],
    sent: new Map(),
    detector: createReviewDetector(),
    remembered: new Map(),
    generation: 0,
    tokenSeq: 0,
    timer: null,
    failures: 0,
    inFlight: null,
    pendingSave: Promise.resolve(),
    loggedStatus: null,
    contributions: null,
    contributionsError: false,
    contributionsTimer: null,
    contributionsInFlight: null,
  })
  const runtimes: Record<Platform, Runtime> = { github: makeRuntime('github'), gitlab: makeRuntime('gitlab') }

  const platformState = (rt: Runtime): PlatformState => ({
    status: rt.status,
    account: rt.account,
    unreviewed: rt.unreviewed,
    updatedAt: rt.updatedAt,
    persistent: tokenStores[rt.platform].persistent,
  })

  const state = (): CodeReviewState => ({ github: platformState(runtimes.github), gitlab: platformState(runtimes.gitlab) })

  const publish = () => {
    if (disposed) return
    for (const rt of PLATFORMS.map((p) => runtimes[p])) {
      if (rt.status !== rt.loggedStatus) {
        log.info('Code review status', { platform: rt.platform, status: rt.status })
        rt.loggedStatus = rt.status
      }
    }
    options.emit(state())
  }

  const clearTimer = (rt: Runtime) => {
    if (rt.timer !== null) timers.clearTimeout(rt.timer)
    rt.timer = null
  }

  const clearContributionsTimer = (rt: Runtime) => {
    if (rt.contributionsTimer !== null) timers.clearTimeout(rt.contributionsTimer)
    rt.contributionsTimer = null
  }

  const emitContributions = (rt: Runtime) => {
    if (disposed) return
    options.emitContributions?.({ platform: rt.platform, error: rt.contributionsError })
  }

  /** Forgets everything tied to the current token (not the stored token itself). */
  const resetSession = (rt: Runtime) => {
    rt.generation++
    clearTimer(rt)
    rt.token = null
    rt.client = null
    rt.account = null
    rt.unreviewed = null
    rt.updatedAt = null
    rt.toReview = []
    rt.mine = []
    rt.sent = new Map()
    rt.remembered = new Map()
    rt.detector.reset()
    rt.failures = 0
    rt.status = 'unconfigured'
    clearContributionsTimer(rt)
    const hadContributions = rt.contributions !== null || rt.contributionsError
    rt.contributions = null
    rt.contributionsError = false
    if (hadContributions) emitContributions(rt)
  }

  const clearStoredToken = (rt: Runtime): Promise<void> =>
    rt.pendingSave
      .then(() => tokenStores[rt.platform].clear())
      .catch((error: unknown) => log.warn('Could not clear the code review token', { platform: rt.platform, error: errorCode(error) }))

  /** Client for a token; null when GitLab has no acceptable URL. */
  const buildClient = (platform: Platform, token: string, baseUrl = gitlabUrl): CodeReviewClient | null => {
    if (platform === 'github') return options.clientFactories.github(token)
    if (baseUrl === '') return null
    try {
      return options.clientFactories.gitlab(baseUrl, token)
    } catch {
      return null
    }
  }

  const schedule = (rt: Runtime, ms: number) => {
    clearTimer(rt)
    if (!started || disposed) return
    rt.timer = timers.setTimeout(() => {
      rt.timer = null
      void poll(rt)
    }, ms)
  }

  const canPoll = (rt: Runtime) => !disposed && started && rt.client !== null && (rt.status === 'ok' || rt.status === 'offline')

  /** Another generation, disposed, or the token was rejected meanwhile (only a new token revives it). */
  const isStale = (rt: Runtime, startedIn: number) => startedIn !== rt.generation || disposed || rt.status === 'auth-error'

  /** The token no longer works: stop asking until a new one is saved. */
  const authFailed = (rt: Runtime) => {
    log.warn('Code review token rejected', { platform: rt.platform })
    clearTimer(rt)
    clearContributionsTimer(rt)
    rt.unreviewed = null
    rt.toReview = []
    rt.mine = []
    rt.sent = new Map()
    rt.status = 'auth-error'
    publish()
  }

  const announce = (rt: Runtime, fresh: { id: string; kind: ReviewKind }[]) => {
    if (fresh.length === 0 || !options.onAlert) return
    if (!options.settings.get().codeReview.alerts[rt.platform].enabled) return
    log.info('Code review first reviews', { platform: rt.platform, count: fresh.length })
    const first = fresh[0]
    const single = fresh.length === 1 && first !== undefined ? rt.mine.find((i) => i.id === first.id) : undefined
    if (single && first) {
      options.onAlert({ platform: rt.platform, count: 1, kind: first.kind, ref: single.ref, title: single.title })
    } else {
      options.onAlert({ platform: rt.platform, count: fresh.length })
    }
  }

  const runPoll = async (rt: Runtime, startedIn: number, client: CodeReviewClient): Promise<void> => {
    try {
      const account = rt.account ?? (await client.viewer())
      const snapshot = await client.fetch()
      if (isStale(rt, startedIn)) return

      // Own open PR/MRs whose review is uncertain this round (a per-MR call failed) keep their last
      // known state, for both the detector and the count; never seen before, they are left out of both.
      const certain = new Map(snapshot.ownReview.map(({ id, review }) => [id, review]))
      const observed: { id: string; review: ReviewState }[] = []
      const remembered = new Map<string, ReviewState>()
      let unreviewed = snapshot.unreviewed
      for (const own of snapshot.mine) {
        if (own.draft) continue
        const known = certain.get(own.id)
        if (known !== undefined) {
          observed.push({ id: own.id, review: known })
          remembered.set(own.id, known)
          continue
        }
        if (own.review === 'none') unreviewed-- // counted from degraded data by the client
        const previous = rt.remembered.get(own.id)
        if (previous === undefined) continue
        observed.push({ id: own.id, review: previous })
        remembered.set(own.id, previous)
        if (previous === 'none') unreviewed++
      }

      rt.account = account
      rt.toReview = snapshot.toReview
      rt.mine = snapshot.mine
      rt.unreviewed = Math.max(0, Math.min(unreviewed, CODE_REVIEW_COUNT_CAP))
      rt.remembered = remembered
      rt.updatedAt = new Date(now()).toISOString()
      rt.failures = 0
      rt.status = 'ok'
      publish()
      schedule(rt, CODE_REVIEW_TICK_MS)
      announce(rt, rt.detector.observe(observed))
    } catch (error) {
      if (isStale(rt, startedIn)) return
      if (error instanceof CodeReviewError && error.code === 'auth') {
        authFailed(rt)
        return
      }
      const wait = CODE_REVIEW_BACKOFF_MS[Math.min(rt.failures, CODE_REVIEW_BACKOFF_MS.length - 1)] ?? CODE_REVIEW_TICK_MS
      rt.failures++
      log.warn('Code review query failed', { platform: rt.platform, code: errorCode(error), retryInMs: wait })
      rt.status = 'offline'
      publish()
      schedule(rt, wait)
    }
  }

  const poll = (rt: Runtime): Promise<void> => {
    if (rt.inFlight && rt.inFlight.generation === rt.generation) return rt.inFlight.run
    if (!canPoll(rt) || rt.client === null) return Promise.resolve()
    clearTimer(rt)
    const entry = { generation: rt.generation, run: Promise.resolve() }
    entry.run = runPoll(rt, rt.generation, rt.client).finally(() => {
      if (rt.inFlight === entry) rt.inFlight = null
    })
    rt.inFlight = entry
    return entry.run
  }

  const scheduleContributions = (rt: Runtime) => {
    clearContributionsTimer(rt)
    if (!viewOpen || !started || disposed) return
    rt.contributionsTimer = timers.setTimeout(() => {
      rt.contributionsTimer = null
      void pollContributions(rt)
    }, CODE_REVIEW_CONTRIBUTIONS_TICK_MS)
  }

  const runContributions = async (rt: Runtime, startedIn: number, client: CodeReviewClient): Promise<void> => {
    try {
      // The range comes from the clock on every query: a new day or month takes effect at once.
      const summary = await client.contributions(new Date(now()))
      if (isStale(rt, startedIn)) return
      rt.contributions = summary
      rt.contributionsError = false
    } catch (error) {
      if (isStale(rt, startedIn)) return
      if (error instanceof CodeReviewError && error.code === 'auth') {
        authFailed(rt)
        // The state's auth-error decides what the view shows; the flag only ends a pending retry.
        rt.contributionsError = true
        emitContributions(rt)
        return
      }
      // Lists, status and the rest of the state stay as they are: only the view's chart shows the error.
      log.warn('Code review contributions query failed', { platform: rt.platform, code: errorCode(error) })
      rt.contributionsError = true
    }
    emitContributions(rt)
    scheduleContributions(rt)
  }

  /** Never with the view closed; one query per platform and generation at a time. */
  const pollContributions = (rt: Runtime): Promise<void> => {
    if (!viewOpen || !canPoll(rt) || rt.client === null) return Promise.resolve()
    if (rt.contributionsInFlight && rt.contributionsInFlight.generation === rt.generation) return rt.contributionsInFlight.run
    clearContributionsTimer(rt)
    const entry = { generation: rt.generation, run: Promise.resolve() }
    entry.run = runContributions(rt, rt.generation, rt.client).finally(() => {
      if (rt.contributionsInFlight === entry) rt.contributionsInFlight = null
    })
    rt.contributionsInFlight = entry
    return entry.run
  }

  const ready = (async () => {
    await Promise.all(
      PLATFORMS.map(async (platform) => {
        const rt = runtimes[platform]
        const startedIn = rt.generation
        if (platform === 'gitlab' && gitlabUrl === '') {
          // No server: a token left behind belongs to nobody.
          await clearStoredToken(rt)
          return
        }
        let token: string | null = null
        try {
          token = await tokenStores[platform].load()
        } catch (error) {
          log.warn('Could not load the code review token', { platform, error: errorCode(error) })
        }
        if (startedIn !== rt.generation || disposed || !token) return
        const client = buildClient(platform, token)
        if (!client) return
        rt.token = token
        rt.client = client
        rt.status = 'ok'
      }),
    )
    publish()
    for (const platform of PLATFORMS) void poll(runtimes[platform])
  })()

  const unsubscribe = options.settings.onChange((next) => {
    if (disposed) return
    const nextUrl = next.codeReview.gitlabUrl
    if (nextUrl === gitlabUrl) return
    // Changed from outside setToken: the token belongs to the old server and must never reach the new one.
    gitlabUrl = nextUrl
    const rt = runtimes.gitlab
    rt.tokenSeq++
    resetSession(rt)
    log.info('GitLab server changed; session closed')
    publish()
    void clearStoredToken(rt)
  })

  const afterInFlight = (rt: Runtime): Promise<void> => rt.inFlight?.run ?? Promise.resolve()

  const failureReason = (platform: Platform, error: unknown): 'auth' | 'network' | 'url' => {
    const code = error instanceof CodeReviewError ? error.code : 'network'
    if (code === 'auth') return 'auth'
    // A server that answers but not like GitLab: most likely a wrong URL.
    if (platform === 'gitlab' && code === 'invalid-response') return 'url'
    return 'network'
  }

  return {
    ready,
    state,

    async list(platform) {
      await ready
      const rt = runtimes[platform]
      await afterInFlight(rt)
      const usable = rt.status === 'ok' || rt.status === 'offline'
      const toReview = usable ? rt.toReview : []
      const mine = usable ? rt.mine : []
      rt.sent = new Map([...toReview, ...mine].map((i) => [i.id, i.url]))
      return { toReview: toReview.map(toReviewItem), mine: mine.map(toReviewItem) }
    },

    refresh() {
      const at = now()
      if (at - lastManualRefresh < CODE_REVIEW_MANUAL_REFRESH_MIN_MS) return
      lastManualRefresh = at
      for (const platform of PLATFORMS) {
        void poll(runtimes[platform])
        void pollContributions(runtimes[platform])
      }
    },

    setViewOpen(open) {
      if (open === viewOpen) return
      viewOpen = open
      for (const platform of PLATFORMS) {
        const rt = runtimes[platform]
        if (open) void pollContributions(rt)
        else clearContributionsTimer(rt)
      }
    },

    async contributions(platform) {
      await ready
      const rt = runtimes[platform]
      const usable = rt.status === 'ok' || rt.status === 'offline'
      return { summary: usable ? rt.contributions : null, error: usable && rt.contributionsError }
    },

    open(platform, id) {
      const rt = runtimes[platform]
      const url = rt.sent.get(id)
      if (url === undefined) {
        log.warn('Refused to open an item not shown in the notch', { platform })
        throw new ExposedIpcError('INVALID_INPUT', 'Unknown item')
      }
      const allowed = platform === 'github' ? GITHUB_WEB_ORIGIN : gitlabUrl === '' ? null : originOf(gitlabUrl)
      if (allowed === null || originOf(url) !== allowed) {
        log.warn('Refused to open an item outside the allowed origin', { platform })
        throw new ExposedIpcError('INVALID_INPUT', 'Item URL not allowed')
      }
      Promise.resolve()
        .then(() => options.openExternal(url))
        .catch((error: unknown) => log.warn('Could not open the item in the browser', { platform, error: errorCode(error) }))
    },

    async setToken(platform, rawToken, url) {
      await ready
      const rt = runtimes[platform]
      const token = rawToken.trim()
      if (token === '') return { ok: false, reason: 'auth' }
      let baseUrl = gitlabUrl
      if (platform === 'gitlab') {
        const parsed = gitlabUrlSchema.safeParse(url ?? gitlabUrl)
        if (!parsed.success) return { ok: false, reason: 'url' }
        baseUrl = parsed.data
      }
      const client = buildClient(platform, token, baseUrl)
      if (!client) return { ok: false, reason: 'url' }
      const seq = ++rt.tokenSeq
      let account: string
      try {
        account = await client.viewer()
      } catch (error) {
        const reason = failureReason(platform, error)
        log.warn('Code review token check failed', { platform, code: errorCode(error) })
        return { ok: false, reason }
      }
      if (seq !== rt.tokenSeq || disposed) return { ok: false, reason: 'network' }

      if (platform === 'gitlab' && baseUrl !== gitlabUrl) {
        // Set first, so the settings change is not taken for an outside one.
        const previousUrl = gitlabUrl
        gitlabUrl = baseUrl
        try {
          await options.settings.update({ codeReview: { ...options.settings.get().codeReview, gitlabUrl: baseUrl } })
        } catch (error) {
          // Settings still hold the old server: keep memory in step with them and keep nothing of the
          // new token (it belongs to a server that was never saved). The current session is untouched.
          log.warn('Could not save the GitLab server', { error: errorCode(error) })
          if (gitlabUrl === baseUrl) gitlabUrl = previousUrl
          return { ok: false, reason: 'network' }
        }
        if (seq !== rt.tokenSeq || disposed) return { ok: false, reason: 'network' }
      }

      resetSession(rt)
      rt.token = token
      rt.client = client
      rt.account = account
      rt.status = 'ok'
      log.info('Code review token saved', { platform, persistent: tokenStores[platform].persistent })
      publish()
      const saving = tokenStores[platform].save(token)
      rt.pendingSave = saving.catch(() => undefined)
      void poll(rt)
      void pollContributions(rt)
      await saving.catch((error: unknown) => log.warn('Could not save the code review token', { platform, error: errorCode(error) }))
      return { ok: true, account }
    },

    async clear(platform) {
      await ready
      const rt = runtimes[platform]
      rt.tokenSeq++
      resetSession(rt)
      publish()
      await clearStoredToken(rt)
    },

    start() {
      if (started) return
      started = true
      for (const platform of PLATFORMS) {
        void poll(runtimes[platform])
        void pollContributions(runtimes[platform])
      }
    },

    dispose() {
      disposed = true
      for (const platform of PLATFORMS) {
        clearTimer(runtimes[platform])
        clearContributionsTimer(runtimes[platform])
      }
      unsubscribe()
    },
  }
}
