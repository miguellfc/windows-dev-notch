import type { GmailMessage, GmailState, GmailStatus } from '../../shared/gmail/schema'
import type { NotchMode } from '../../shared/notch/state'
import type { GmailSettings } from '../../shared/settings/schema'
import type { Logger } from '../services/logger'
import { GmailAuthError } from './auth-error'
import type { GmailAuth } from './gmail-auth'
import { GmailApiError, type GmailClient } from './gmail-client'
import type { TokenStore } from './token-store'

/** Unread count rhythm while the capsule is visible. */
export const GMAIL_TICK_MS = 60_000
/** Waits after consecutive network / 5xx / 429 failures: 1 → 2 → 4 → 5 min (max). */
export const GMAIL_BACKOFF_MS = [60_000, 120_000, 240_000, 300_000] as const
/** Minimum time between two manual refreshes. */
export const GMAIL_MANUAL_REFRESH_MIN_MS = 5_000
/** An access token this close to expiry is refreshed before use. */
const ACCESS_TOKEN_MARGIN_MS = 60_000
export const GMAIL_INBOX_URL = 'https://mail.google.com/mail/u/0/#inbox'

/** Like the system monitor: nothing in mini, hidden or alert (the capsule is a pill, off screen or busy). */
const PAUSED_MODES: ReadonlySet<NotchMode> = new Set<NotchMode>(['mini', 'hidden', 'alert'])

/** The capsule shows compact, peek or a panel: Gmail polls. */
export const isGmailVisibleMode = (mode: NotchMode): boolean => !PAUSED_MODES.has(mode)

/**
 * Dev/E2E switch `NOTCH_GMAIL_BASE_URL`: accepted only as an exact `http://127.0.0.1:<port>`
 * origin (no path, no credentials, no other host). Anything else is ignored.
 */
export function parseGmailBaseOverride(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(raw)
  if (!match) return undefined
  const port = Number(match[1])
  return port >= 1 && port <= 65_535 ? raw : undefined
}

export interface GmailCredentials {
  clientId: string
  clientSecret: string
}

/** What the REST client needs from the integration to authenticate its requests. */
export interface GmailClientAccess {
  getAccessToken: () => Promise<string>
  /** Forces one token refresh; true when a new access token is available. */
  onUnauthorized: () => Promise<boolean>
}

export interface GmailTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface GmailSettingsSource {
  get(): { readonly gmail: GmailSettings }
  onChange(listener: (settings: { readonly gmail: GmailSettings }) => void): () => void
}

export interface GmailIntegrationOptions {
  settings: GmailSettingsSource
  tokenStore: Pick<TokenStore, 'load' | 'save' | 'clear' | 'persistent'>
  authFactory: (credentials: GmailCredentials) => GmailAuth
  clientFactory: (access: GmailClientAccess) => GmailClient
  timers: GmailTimers
  now: () => number
  /** Pushes `gmail:state` to the notch and the Control Center. */
  emit: (state: GmailState) => void
  openExternal: (url: string) => Promise<void> | void
  logger: Logger
}

export type GmailSignInResult = 'ok' | 'cancelled' | 'error'

export interface GmailIntegration {
  /** Resolves once the stored token was read (never rejects). */
  readonly ready: Promise<void>
  state(): GmailState
  /** The last recent list (empty without a session); remembered as the list `open` accepts. */
  recent(): Promise<GmailMessage[]>
  setVisible(visible: boolean): void
  setViewOpen(open: boolean): void
  refresh(): void
  open(id?: string): void
  signIn(): Promise<GmailSignInResult>
  cancelSignIn(): void
  signOut(): Promise<void>
  dispose(): void
}

const credentialsOf = (settings: { readonly gmail: GmailSettings }): GmailCredentials => ({
  clientId: settings.gmail.clientId.trim(),
  clientSecret: settings.gmail.clientSecret.trim(),
})

/** Only a code or an error name: messages could quote tokens or mail data. */
const errorCode = (error: unknown): string => {
  if (error instanceof GmailApiError || error instanceof GmailAuthError) return error.code
  return error instanceof Error ? error.name : typeof error
}

const isSessionDead = (error: unknown): boolean =>
  (error instanceof GmailApiError && error.code === 'unauthorized') || (error instanceof GmailAuthError && error.code === 'denied')

/**
 * Gmail state machine for main: loads the stored token, polls the unread count every 60 s while
 * the capsule is visible (plus the recent list while the view is open), backs off on network
 * trouble and drives sign-in / sign-out. Logs only states and error codes.
 */
export function createGmailIntegration(options: GmailIntegrationOptions): GmailIntegration {
  const { tokenStore, timers, now } = options
  const log = options.logger.child('gmail')

  let credentials = credentialsOf(options.settings.get())
  const configured = () => credentials.clientId !== ''

  let status: GmailStatus = configured() ? 'signed-out' : 'unconfigured'
  let account: string | null = null
  let unread: number | null = null
  let updatedAt: string | null = null
  let messages: GmailMessage[] = []
  /** The last list handed to the notch: `open` only accepts its ids. */
  let sent: GmailMessage[] = []

  let refreshToken: string | null = null
  let access: { token: string; expiresAt: number } | null = null
  let refreshing: { generation: number; run: Promise<string> } | null = null

  /** Bumped whenever the session changes (sign-in, sign-out, new client): stale results are dropped. */
  let generation = 0
  let session: { auth: GmailAuth; client: GmailClient | null; clientGeneration: number } | null = null

  let visible = false
  let viewOpen = false
  let timer: unknown = null
  let failures = 0
  let inFlight: { generation: number; run: Promise<void> } | null = null
  let lastManualRefresh = Number.NEGATIVE_INFINITY

  let signInSeq = 0
  /** Sequence number of the sign-in waiting for the browser, if any. */
  let pendingSignIn: number | null = null
  /** A token save from a finished sign-in; a clear waits for it so the token never outlives a sign-out. */
  let pendingSave: Promise<void> = Promise.resolve()
  let statusBeforeSignIn: GmailStatus | null = null
  let disposed = false
  let loggedStatus: GmailStatus | null = null

  const state = (): GmailState => ({ status, account, unread, updatedAt, persistent: tokenStore.persistent })

  const publish = () => {
    if (disposed) return
    if (status !== loggedStatus) {
      log.info('Gmail status', { status })
      loggedStatus = status
    }
    options.emit(state())
  }

  const clearTimer = () => {
    if (timer !== null) timers.clearTimeout(timer)
    timer = null
  }

  /** Forgets everything tied to the current session (not the stored token). */
  const resetSession = () => {
    generation++
    clearTimer()
    refreshToken = null
    access = null
    refreshing = null
    account = null
    unread = null
    updatedAt = null
    messages = []
    sent = []
    failures = 0
  }

  const clearStoredToken = () =>
    pendingSave
      .then(() => tokenStore.clear())
      .catch((error: unknown) => log.warn('Could not clear the Gmail token', { error: errorCode(error) }))

  /** Thrown to results of a session that no longer exists; they are dropped, never shown. */
  const stale = () => new GmailApiError('unauthorized')

  const refreshAccess = (): Promise<string> => {
    if (refreshing && refreshing.generation === generation) return refreshing.run
    const token = refreshToken
    if (token === null) return Promise.reject(stale())
    const startedIn = generation
    const entry = { generation: startedIn, run: Promise.resolve('') }
    entry.run = getSession()
      .auth.refresh(token)
      .then((next) => {
        if (startedIn !== generation) throw stale()
        access = { token: next.accessToken, expiresAt: next.expiresAt }
        return next.accessToken
      })
      .finally(() => {
        if (refreshing === entry) refreshing = null
      })
    refreshing = entry
    return entry.run
  }

  /** Token access bound to one session generation: calls from an older session change nothing. */
  const accessFor = (owner: number): GmailClientAccess => ({
    getAccessToken: async () => {
      if (owner !== generation) throw stale()
      if (access && access.expiresAt - now() > ACCESS_TOKEN_MARGIN_MS) return access.token
      return refreshAccess()
    },
    onUnauthorized: async () => {
      if (owner !== generation) return false
      access = null
      try {
        await refreshAccess()
        return true
      } catch (error) {
        if (error instanceof GmailAuthError && error.code === 'denied') return false
        throw error
      }
    },
  })

  /** Auth for the current credentials (rebuilt after the client id or secret changes). */
  const getSession = () => {
    session ??= { auth: options.authFactory({ ...credentials }), client: null, clientGeneration: -1 }
    return session
  }

  /** Client for the current session generation. */
  const getClient = (): GmailClient => {
    const current = getSession()
    if (!current.client || current.clientGeneration !== generation) {
      current.client = options.clientFactory(accessFor(generation))
      current.clientGeneration = generation
    }
    return current.client
  }
  const schedule = (ms: number) => {
    clearTimer()
    if (!visible || disposed) return
    timer = timers.setTimeout(() => {
      timer = null
      void poll()
    }, ms)
  }

  const canPoll = () => !disposed && visible && refreshToken !== null && (status === 'ok' || status === 'offline')

  /** A result that arrives after the session changed, or while signing in, is dropped. */
  const isStale = (startedIn: number) => startedIn !== generation || disposed || status === 'signing-in'

  const runPoll = async (startedIn: number, withRecent: boolean): Promise<void> => {
    try {
      const client = getClient()
      const nextAccount = account ?? (await client.profile())
      const count = await client.unreadCount()
      let list: GmailMessage[] | null = null
      if (withRecent) {
        try {
          list = await client.recent()
        } catch (error) {
          // The count is still good: a failed list keeps the last one, unless the session died.
          if (isSessionDead(error)) throw error
          if (!isStale(startedIn)) log.warn('Gmail recent list failed', { code: errorCode(error) })
        }
      }
      if (isStale(startedIn)) return
      account = nextAccount
      unread = count
      updatedAt = new Date(now()).toISOString()
      if (list) messages = list
      failures = 0
      status = 'ok'
      publish()
      schedule(GMAIL_TICK_MS)
    } catch (error) {
      if (isStale(startedIn)) return
      if (isSessionDead(error)) {
        log.warn('Gmail session expired', { code: errorCode(error) })
        // Keep the refresh token out of use: nothing is asked until the user signs in again.
        clearTimer()
        access = null
        messages = []
        sent = []
        status = 'expired'
        publish()
        return
      }
      const wait = GMAIL_BACKOFF_MS[Math.min(failures, GMAIL_BACKOFF_MS.length - 1)] ?? GMAIL_TICK_MS
      failures++
      log.warn('Gmail query failed', { code: errorCode(error), retryInMs: wait })
      status = 'offline'
      publish()
      schedule(wait)
    }
  }
  const poll = (): Promise<void> => {
    if (inFlight && inFlight.generation === generation) return inFlight.run
    if (!canPoll()) return Promise.resolve()
    clearTimer()
    const entry = { generation, run: Promise.resolve() }
    entry.run = runPoll(generation, viewOpen).finally(() => {
      if (inFlight === entry) inFlight = null
    })
    inFlight = entry
    return entry.run
  }

  const afterInFlight = (): Promise<void> => inFlight?.run ?? Promise.resolve()

  const ready = (async () => {
    const startedIn = generation
    try {
      if (!configured()) {
        // No client: a token left behind belongs to nobody.
        await clearStoredToken()
        return
      }
      let token: string | null = null
      try {
        token = await tokenStore.load()
      } catch (error) {
        log.warn('Could not load the Gmail token', { error: errorCode(error) })
      }
      if (startedIn !== generation || disposed) return
      if (token) {
        refreshToken = token
        status = 'ok'
      }
    } finally {
      if (startedIn === generation) publish()
    }
    void poll()
  })()

  const unsubscribe = options.settings.onChange((next) => {
    if (disposed) return
    const nextCredentials = credentialsOf(next)
    if (nextCredentials.clientId === credentials.clientId && nextCredentials.clientSecret === credentials.clientSecret) return
    // A new client closes the session: no request may go out with the old one.
    signInSeq++
    pendingSignIn = null
    statusBeforeSignIn = null
    session?.auth.cancel()
    session = null
    credentials = nextCredentials
    resetSession()
    status = configured() ? 'signed-out' : 'unconfigured'
    log.info('Gmail client changed; session closed')
    publish()
    void clearStoredToken()
  })

  return {
    ready,
    state,

    async recent() {
      await ready
      await afterInFlight()
      sent = status === 'ok' || status === 'offline' ? messages : []
      return [...sent]
    },

    setVisible(next) {
      if (next === visible) return
      visible = next
      if (!next) {
        clearTimer()
        return
      }
      void poll() // resuming after mini / hidden asks at once
    },

    setViewOpen(open) {
      const opening = open && !viewOpen
      viewOpen = open
      if (opening && status === 'ok') void afterInFlight().then(() => poll())
    },

    refresh() {
      const at = now()
      if (at - lastManualRefresh < GMAIL_MANUAL_REFRESH_MIN_MS) return
      lastManualRefresh = at
      void poll()
    },

    open(id) {
      let url = GMAIL_INBOX_URL
      if (id !== undefined) {
        const target = sent.find((m) => m.id === id)
        if (!target) {
          log.warn('Refused to open a message outside the last list')
          return
        }
        url = `${GMAIL_INBOX_URL}/${encodeURIComponent(target.threadId)}`
      }
      Promise.resolve()
        .then(() => options.openExternal(url))
        .catch((error: unknown) => log.warn('Could not open Gmail in the browser', { error: errorCode(error) }))
    },

    async signIn() {
      await ready
      if (disposed || !configured()) return 'error'
      const seq = ++signInSeq
      pendingSignIn = seq
      const startedIn = generation
      if (status !== 'signing-in') statusBeforeSignIn = status
      status = 'signing-in'
      clearTimer()
      publish()
      try {
        const result = await getSession().auth.signIn()
        if (seq !== signInSeq || startedIn !== generation || disposed) return 'cancelled'
        statusBeforeSignIn = null
        pendingSignIn = null
        const saving = tokenStore.save(result.refreshToken)
        pendingSave = saving.catch(() => undefined)
        resetSession()
        refreshToken = result.refreshToken
        access = { token: result.accessToken, expiresAt: result.expiresAt }
        status = 'ok'
        publish()
        void poll()
        await saving.catch((error: unknown) => log.warn('Could not save the Gmail token', { error: errorCode(error) }))
        return 'ok'
      } catch (error) {
        if (seq !== signInSeq || startedIn !== generation || disposed) return 'cancelled'
        pendingSignIn = null
        const code = errorCode(error)
        log.warn('Gmail sign-in did not finish', { code })
        const previous = statusBeforeSignIn
        statusBeforeSignIn = null
        if ((previous === 'ok' || previous === 'offline') && refreshToken !== null) {
          status = previous
          publish()
          void poll()
        } else {
          // From signed-out or expired: any old token is dead, drop it so the state is truthful.
          const hadToken = refreshToken !== null
          resetSession()
          status = 'signed-out'
          publish()
          if (hadToken) await clearStoredToken()
        }
        return code === 'cancelled' ? 'cancelled' : 'error'
      }
    },

    cancelSignIn() {
      if (pendingSignIn !== null) session?.auth.cancel()
    },

    async signOut() {
      await ready
      signInSeq++
      pendingSignIn = null
      statusBeforeSignIn = null
      session?.auth.cancel()
      const token = refreshToken
      const auth = session?.auth
      resetSession()
      status = configured() ? 'signed-out' : 'unconfigured'
      publish()
      await Promise.all([
        token !== null && auth ? auth.revoke(token).catch(() => undefined) : Promise.resolve(),
        clearStoredToken(),
      ])
    },

    dispose() {
      disposed = true
      clearTimer()
      signInSeq++
      pendingSignIn = null
      session?.auth.cancel()
      unsubscribe()
    },
  }
}
