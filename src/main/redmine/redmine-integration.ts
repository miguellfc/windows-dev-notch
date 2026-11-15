import { localDate, weekStart } from '../../shared/code-review/contributions'
import type {
  LogTimeInput,
  RedmineActivity,
  RedmineIssueDetail,
  RedmineIssueList,
  RedmineSetKeyResult,
  RedmineState,
  RedmineStatus,
  RedmineSummary,
  RedmineSummaryChanged,
  RedmineSummaryResult,
  RedmineWriteResult,
  UpdateIssueInput,
} from '../../shared/redmine/schema'
import { normalizeRedmineUrl } from '../../shared/redmine/url'
import type { RedmineSettings } from '../../shared/settings/schema'
import { CodeReviewError } from '../code-review/client-common'
import { ExposedIpcError } from '../ipc/errors'
import type { Logger } from '../services/logger'
import type { TokenStore } from '../services/secure-token-store'
import type { RedmineClient } from './redmine-client'

/** Today's hours and the assigned issues: one query every 5 minutes, in every notch mode. */
export const REDMINE_TICK_MS = 300_000
/** Waits after consecutive network / 5xx / 429 / invalid-response failures: 1 → 2 → 4 → 5 min (max). */
export const REDMINE_BACKOFF_MS = [60_000, 120_000, 240_000, 300_000] as const
/** Month summary rhythm, only while the Redmine view is open. */
export const REDMINE_SUMMARY_TICK_MS = 900_000
/** Minimum time between two manual refreshes. */
export const REDMINE_MANUAL_REFRESH_MIN_MS = 5_000

const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/

/** Dev/E2E switch `NOTCH_REDMINE_BASE_URL`: only an exact `http://127.0.0.1:<port>` origin; anything else turns it off. */
export function parseRedmineBaseOverride(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const value = raw.trim()
  const match = LOOPBACK_ORIGIN.exec(value)
  const port = match ? Number(match[1]) : 0
  return match && port >= 1 && port <= 65_535 ? value : undefined
}

export interface RedmineTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface RedmineSettingsSource {
  get(): { readonly redmine: RedmineSettings }
  onChange(listener: (settings: { readonly redmine: RedmineSettings }) => void): () => void
  /** Saves the server URL after a key passed validation (through the settings updater). */
  update(patch: { redmine: { url: string } }): Promise<unknown>
}

export interface RedmineIntegrationOptions {
  settings: RedmineSettingsSource
  tokenStore: Pick<TokenStore, 'load' | 'save' | 'clear' | 'persistent'>
  /** `baseUrl` is the normalized https URL from settings; may throw if it is not acceptable. */
  clientFactory: (baseUrl: string, apiKey: string) => RedmineClient
  timers: RedmineTimers
  now: () => number
  /** Pushes `redmine:state` to the notch and the Control Center. */
  emit: (state: RedmineState) => void
  /** Pushes `redmine:summary-changed` to the notch (summary replaced or cleared, or a query ended). */
  emitSummary: (change: RedmineSummaryChanged) => void
  openExternal: (url: string) => Promise<void> | void
  logger: Logger
}

export interface RedmineIntegration {
  /** Resolves once the stored key was read (never rejects). */
  readonly ready: Promise<void>
  state(): RedmineState
  /** Hours logged today with a session (`ok`/`offline`), else null (also when the last reading is from an earlier day); for the end-of-day alert. */
  todayHours(): number | null
  /** The last list of open assigned issues (no URLs); remembered as the ids `open` accepts. */
  issues(): Promise<RedmineIssueList>
  /** One issue with its allowed statuses; ExposedIpcError UNAVAILABLE without a session or on failure. */
  issue(id: number): Promise<RedmineIssueDetail>
  activities(): Promise<RedmineActivity[]>
  /** Never throws for Redmine's refusals; a success refreshes issues, today's hours (and the open summary). */
  updateIssue(input: UpdateIssueInput): Promise<RedmineWriteResult>
  logTime(input: LogTimeInput): Promise<RedmineWriteResult>
  /** The cached month summary (null without a session or not loaded yet) and the last query's error; never queries. */
  summary(): Promise<RedmineSummaryResult>
  /** The Redmine view opened or closed: the summary is queried on open and every 15 min while open. */
  setViewOpen(open: boolean): void
  /** Queries now (at most every 5 s); the summary too while the view is open. */
  refresh(): void
  /** Opens an issue of the last list sent or one read with `issue(id)`, only on the configured server's origin; else ExposedIpcError. */
  open(id: number): void
  /** Validates the key (and URL) against the server before saving anything. */
  setKey(url: string, key: string): Promise<RedmineSetKeyResult>
  clear(): Promise<void>
  /** Starts the rhythm (main calls it once the IPC targets exist). */
  start(): void
  dispose(): void
}

/** Only a code or an error name: messages could quote the key, subjects or URLs. */
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

/** Hundredths: sums of float hours (0.1 + 0.2) never show noise. */
const round2 = (hours: number): number => Math.round(hours * 100) / 100

const sumHours = (entries: readonly { hours: number }[]): number => round2(entries.reduce((total, entry) => total + entry.hours, 0))

/**
 * The month summary from the entries between min(1st of the month, Monday of the week) and today:
 * today, the week (from Monday), the month, and one day per date from the 1st to today.
 */
function summarizeHours(entries: readonly { date: string; hours: number }[], now: Date): RedmineSummary {
  const today = localDate(now)
  const monday = localDate(weekStart(now))
  const first = new Date(now.getFullYear(), now.getMonth(), 1)
  const monthFirst = localDate(first)
  const byDay = new Map<string, number>()
  for (const { date, hours } of entries) byDay.set(date, (byDay.get(date) ?? 0) + hours)
  const total = (from: string) => round2([...byDay].reduce((sum, [date, hours]) => (date >= from && date <= today ? sum + hours : sum), 0))
  const days: RedmineSummary['days'] = []
  for (let day = 1; day <= now.getDate(); day++) {
    const date = localDate(new Date(now.getFullYear(), now.getMonth(), day))
    days.push({ date, hours: round2(byDay.get(date) ?? 0) })
  }
  return { month: monthFirst.slice(0, 7), days, today: round2(byDay.get(today) ?? 0), week: total(monday), monthTotal: total(monthFirst) }
}

/**
 * Redmine state machine for main: key, client, generation, rhythm, backoff and the month summary.
 * Logs only states, counts and codes (never the key, subjects, comments, accounts or URLs).
 */
export function createRedmineIntegration(options: RedmineIntegrationOptions): RedmineIntegration {
  const { tokenStore, timers, now } = options
  const log = options.logger.child('redmine')

  let serverUrl = options.settings.get().redmine.url
  let started = false
  let disposed = false
  let lastManualRefresh = Number.NEGATIVE_INFINITY
  let viewOpen = false

  let client: RedmineClient | null = null
  let status: RedmineStatus = 'unconfigured'
  let account: string | null = null
  let todayHours: number | null = null
  /** Local date the `todayHours` reading belongs to: after midnight it is no longer "today's". */
  let todayHoursDay: string | null = null
  let updatedAt: number | null = null
  let issueList: RedmineIssueList = { issues: [], truncated: false }
  /** Ids of the last list handed to the notch: `open` only accepts these. */
  let sent = new Set<number>()
  /** Ids read with `issue(id)` in this session: still openable after they leave the open list (e.g. closed). */
  let readIssues = new Set<number>()
  /** Bumped whenever the key, URL or session changes: stale results are dropped. */
  let generation = 0
  /** Bumped by every setKey/clear: an older validation that finishes later changes nothing. */
  let keySeq = 0
  let timer: unknown = null
  let failures = 0
  let inFlight: { generation: number; run: Promise<void> } | null = null
  /** A key save in progress; a clear waits for it so the key never outlives a removal. */
  let pendingSave: Promise<void> = Promise.resolve()
  let loggedStatus: RedmineStatus | null = null
  let summary: RedmineSummary | null = null
  let summaryError = false
  let summaryTimer: unknown = null
  let summaryInFlight: { generation: number; run: Promise<void> } | null = null

  const usable = () => status === 'ok' || status === 'offline'

  /** The last reading only while it is still the same local day: yesterday's hours are never today's. */
  const currentTodayHours = (): number | null => (todayHoursDay === localDate(new Date(now())) ? todayHours : null)

  const state = (): RedmineState => ({
    status,
    account,
    todayHours: currentTodayHours(),
    updatedAt,
    persistent: tokenStore.persistent,
  })

  const publish = () => {
    if (disposed) return
    if (status !== loggedStatus) {
      log.info('Redmine status', { status })
      loggedStatus = status
    }
    options.emit(state())
  }

  const clearTimer = () => {
    if (timer !== null) timers.clearTimeout(timer)
    timer = null
  }

  const clearSummaryTimer = () => {
    if (summaryTimer !== null) timers.clearTimeout(summaryTimer)
    summaryTimer = null
  }

  const emitSummary = () => {
    if (disposed) return
    options.emitSummary({ error: summaryError })
  }

  /** Forgets everything tied to the current key (not the stored key itself). */
  const resetSession = () => {
    generation++
    clearTimer()
    client = null
    account = null
    todayHours = null
    updatedAt = null
    issueList = { issues: [], truncated: false }
    sent = new Set()
    readIssues = new Set()
    failures = 0
    status = 'unconfigured'
    clearSummaryTimer()
    const hadSummary = summary !== null || summaryError
    summary = null
    summaryError = false
    if (hadSummary) emitSummary()
  }

  const clearStoredKey = (): Promise<void> =>
    pendingSave
      .then(() => tokenStore.clear())
      .catch((error: unknown) => log.warn('Could not clear the Redmine key', { error: errorCode(error) }))

  /** Client for a key; null when there is no acceptable URL. */
  const buildClient = (baseUrl: string, key: string): RedmineClient | null => {
    if (baseUrl === '') return null
    try {
      return options.clientFactory(baseUrl, key)
    } catch {
      return null
    }
  }

  const schedule = (ms: number) => {
    clearTimer()
    if (!started || disposed) return
    timer = timers.setTimeout(() => {
      timer = null
      void poll()
    }, ms)
  }

  const canPoll = () => !disposed && started && client !== null && usable()

  /** Another generation, disposed, or the key was rejected meanwhile (only a new key revives it). */
  const isStale = (startedIn: number) => startedIn !== generation || disposed || status === 'auth-error'

  /** The key no longer works: stop asking until a new one is saved. */
  const authFailed = () => {
    log.warn('Redmine key rejected')
    clearTimer()
    clearSummaryTimer()
    todayHours = null
    issueList = { issues: [], truncated: false }
    sent = new Set()
    readIssues = new Set()
    status = 'auth-error'
    publish()
  }

  const runPoll = async (startedIn: number, current: RedmineClient): Promise<void> => {
    try {
      const name = account ?? (await current.viewer()).name
      // The day comes from the clock on every query: midnight takes effect at once.
      const today = localDate(new Date(now()))
      const [list, entries] = await Promise.all([current.issues(), current.timeEntries(today, today)])
      if (isStale(startedIn)) return
      account = name
      issueList = list
      todayHours = sumHours(entries.filter((entry) => entry.date === today))
      todayHoursDay = today
      updatedAt = now()
      failures = 0
      status = 'ok'
      publish()
      schedule(REDMINE_TICK_MS)
    } catch (error) {
      if (isStale(startedIn)) return
      if (error instanceof CodeReviewError && error.code === 'auth') {
        authFailed()
        return
      }
      const wait = REDMINE_BACKOFF_MS[Math.min(failures, REDMINE_BACKOFF_MS.length - 1)] ?? REDMINE_TICK_MS
      failures++
      log.warn('Redmine query failed', { code: errorCode(error), retryInMs: wait })
      status = 'offline'
      publish()
      schedule(wait)
    }
  }

  const poll = (): Promise<void> => {
    if (inFlight && inFlight.generation === generation) return inFlight.run
    if (!canPoll() || client === null) return Promise.resolve()
    clearTimer()
    const entry = { generation, run: Promise.resolve() }
    entry.run = runPoll(generation, client).finally(() => {
      if (inFlight === entry) inFlight = null
    })
    inFlight = entry
    return entry.run
  }

  const scheduleSummary = () => {
    clearSummaryTimer()
    if (!viewOpen || !started || disposed) return
    summaryTimer = timers.setTimeout(() => {
      summaryTimer = null
      void pollSummary()
    }, REDMINE_SUMMARY_TICK_MS)
  }

  const runSummary = async (startedIn: number, current: RedmineClient): Promise<void> => {
    try {
      // The range comes from the clock on every query: a new day, week or month takes effect at once.
      const at = new Date(now())
      const firstOfMonth = new Date(at.getFullYear(), at.getMonth(), 1)
      const monday = weekStart(at)
      const from = localDate(monday < firstOfMonth ? monday : firstOfMonth)
      const entries = await current.timeEntries(from, localDate(at))
      if (isStale(startedIn)) return
      summary = summarizeHours(entries, at)
      summaryError = false
    } catch (error) {
      if (isStale(startedIn)) return
      if (error instanceof CodeReviewError && error.code === 'auth') {
        authFailed()
        // The state's auth-error decides what the view shows; the flag only ends a pending retry.
        summaryError = true
        emitSummary()
        return
      }
      // The issues, hours and status stay as they are: only the view's summary shows the error.
      log.warn('Redmine summary query failed', { code: errorCode(error) })
      summaryError = true
    }
    emitSummary()
    scheduleSummary()
  }

  /** Never with the view closed; one query per generation at a time. */
  const pollSummary = (): Promise<void> => {
    if (!viewOpen || !canPoll() || client === null) return Promise.resolve()
    if (summaryInFlight && summaryInFlight.generation === generation) return summaryInFlight.run
    clearSummaryTimer()
    const entry = { generation, run: Promise.resolve() }
    entry.run = runSummary(generation, client).finally(() => {
      if (summaryInFlight === entry) summaryInFlight = null
    })
    summaryInFlight = entry
    return entry.run
  }

  const ready = (async () => {
    const startedIn = generation
    if (serverUrl === '') {
      // No server: a key left behind belongs to nobody.
      await clearStoredKey()
      return
    }
    let key: string | null = null
    try {
      key = await tokenStore.load()
    } catch (error) {
      log.warn('Could not load the Redmine key', { error: errorCode(error) })
    }
    if (startedIn !== generation || disposed || !key) return
    const built = buildClient(serverUrl, key)
    if (!built) return
    client = built
    status = 'ok'
  })().then(() => {
    publish()
    void poll()
  })

  const unsubscribe = options.settings.onChange((next) => {
    if (disposed) return
    const nextUrl = next.redmine.url
    if (nextUrl === serverUrl) return
    // Changed from outside setKey: the key belongs to the old server and must never reach the new one.
    serverUrl = nextUrl
    keySeq++
    resetSession()
    log.info('Redmine server changed; session closed')
    publish()
    void clearStoredKey()
  })

  const afterInFlight = (): Promise<void> => inFlight?.run ?? Promise.resolve()

  /** The client of a usable session, or UNAVAILABLE for the renderer. */
  const sessionClient = (): RedmineClient => {
    if (client === null || !usable()) throw new ExposedIpcError('UNAVAILABLE', 'Redmine is not connected')
    return client
  }

  /** A read for the view: auth turns the session auth-error; every failure is UNAVAILABLE with a code only. */
  const read = async <T>(what: string, run: (current: RedmineClient) => Promise<T>): Promise<T> => {
    await ready
    const current = sessionClient()
    const startedIn = generation
    const stale = () => new ExposedIpcError('UNAVAILABLE', 'Redmine session changed')
    let result: T
    try {
      result = await run(current)
    } catch (error) {
      if (isStale(startedIn)) throw stale()
      if (error instanceof CodeReviewError && error.code === 'auth') {
        authFailed()
        throw new ExposedIpcError('UNAVAILABLE', 'Redmine key rejected')
      }
      const code = errorCode(error)
      log.warn('Redmine read failed', { what, code })
      throw new ExposedIpcError('UNAVAILABLE', `Redmine request failed: ${code}`)
    }
    // An answer for a session that ended meanwhile (clear, new key or server, dispose) is never handed out.
    if (isStale(startedIn)) throw stale()
    return result
  }

  /** After a successful write: issues and today's hours again (the summary too with the view open), then publish. */
  const refreshAfterWrite = async () => {
    // A query started before the write may have read the old data: wait for it, then ask again.
    await afterInFlight()
    await poll()
    if (viewOpen) {
      await (summaryInFlight?.run ?? Promise.resolve())
      await pollSummary()
    }
  }

  const write = async (what: string, run: (current: RedmineClient) => Promise<RedmineWriteResult>): Promise<RedmineWriteResult> => {
    await ready
    if (client === null || !usable()) return { ok: false, reason: 'auth' }
    const startedIn = generation
    const result = await run(client)
    log.info('Redmine write', { what, result: result.ok ? 'ok' : result.reason })
    if (isStale(startedIn)) return result
    if (result.ok) await refreshAfterWrite()
    else if (result.reason === 'auth') authFailed()
    // 403/404/422 and transport failures go back to the form; the session stays as it is.
    return result
  }

  const failureReason = (error: unknown): 'auth' | 'network' | 'url' => {
    const code = error instanceof CodeReviewError ? error.code : 'network'
    if (code === 'auth') return 'auth'
    // A server that answers but not like Redmine: most likely a wrong URL.
    if (code === 'invalid-response') return 'url'
    return 'network'
  }

  return {
    ready,
    state,

    todayHours: () => (usable() ? currentTodayHours() : null),

    async issues() {
      await ready
      await afterInFlight()
      const list = usable() ? issueList : { issues: [], truncated: false }
      sent = new Set(list.issues.map((issue) => issue.id))
      return list
    },

    async issue(id) {
      const detail = await read('issue', (current) => current.issue(id))
      readIssues.add(id)
      return detail
    },

    activities: () => read('activities', (current) => current.activities()),

    updateIssue: ({ id, statusId, estimatedHours }) =>
      write('update-issue', (current) =>
        current.updateIssue(id, {
          ...(statusId === undefined ? {} : { statusId }),
          ...(estimatedHours === undefined ? {} : { estimatedHours }),
        }),
      ),

    logTime: (input) => write('log-time', (current) => current.logTime(input)),

    async summary() {
      await ready
      return { summary: usable() ? summary : null, error: usable() && summaryError }
    },

    setViewOpen(open) {
      if (open === viewOpen) return
      viewOpen = open
      if (open) void pollSummary()
      else clearSummaryTimer()
    },

    refresh() {
      const at = now()
      if (at - lastManualRefresh < REDMINE_MANUAL_REFRESH_MIN_MS) return
      lastManualRefresh = at
      void poll()
      void pollSummary()
    },

    open(id) {
      if (!(sent.has(id) || readIssues.has(id)) || client === null) {
        log.warn('Refused to open an issue not shown in the notch')
        throw new ExposedIpcError('INVALID_INPUT', 'Unknown issue')
      }
      const url = client.issueUrl(id)
      const allowed = serverUrl === '' ? null : originOf(serverUrl)
      if (allowed === null || originOf(url) !== allowed) {
        log.warn('Refused to open an issue outside the configured server')
        throw new ExposedIpcError('INVALID_INPUT', 'Issue URL not allowed')
      }
      Promise.resolve()
        .then(() => options.openExternal(url))
        .catch((error: unknown) => log.warn('Could not open the issue in the browser', { error: errorCode(error) }))
    },

    async setKey(rawUrl, rawKey) {
      await ready
      const key = rawKey.trim()
      if (key === '') return { ok: false, reason: 'auth' }
      const baseUrl = normalizeRedmineUrl(rawUrl)
      if (baseUrl === null) return { ok: false, reason: 'url' }
      const candidate = buildClient(baseUrl, key)
      if (!candidate) return { ok: false, reason: 'url' }
      const seq = ++keySeq
      let name: string
      try {
        name = (await candidate.viewer()).name
      } catch (error) {
        log.warn('Redmine key check failed', { code: errorCode(error) })
        return { ok: false, reason: failureReason(error) }
      }
      if (seq !== keySeq || disposed) return { ok: false, reason: 'network' }

      if (baseUrl !== serverUrl) {
        // Set first, so the settings change is not taken for an outside one.
        const previousUrl = serverUrl
        serverUrl = baseUrl
        try {
          await options.settings.update({ redmine: { url: baseUrl } })
        } catch (error) {
          // Settings still hold the old server: keep memory in step with them and keep nothing of the
          // new key (it belongs to a server that was never saved). The current session is untouched.
          log.warn('Could not save the Redmine server', { error: errorCode(error) })
          if (serverUrl === baseUrl) serverUrl = previousUrl
          return { ok: false, reason: 'network' }
        }
        if (seq !== keySeq || disposed) return { ok: false, reason: 'network' }
      }

      resetSession()
      client = candidate
      account = name
      status = 'ok'
      log.info('Redmine key saved', { persistent: tokenStore.persistent })
      publish()
      const saving = tokenStore.save(key)
      pendingSave = saving.catch(() => undefined)
      void poll()
      void pollSummary()
      await saving.catch((error: unknown) => log.warn('Could not save the Redmine key', { error: errorCode(error) }))
      return { ok: true, account: name }
    },

    async clear() {
      await ready
      keySeq++
      resetSession()
      publish()
      await clearStoredKey()
    },

    start() {
      if (started) return
      started = true
      void poll()
      void pollSummary()
    },

    dispose() {
      disposed = true
      clearTimer()
      clearSummaryTimer()
      unsubscribe()
    },
  }
}
