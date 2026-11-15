import {
  GMAIL_UNREAD_CAP,
  isWebUrl,
  type GmailLink,
  type GmailMessage,
  type GmailMessageDetail,
  type GmailNewMail,
  type GmailState,
  type GmailStatus,
} from '../../shared/gmail/schema'
import type { GmailSettings } from '../../shared/settings/schema'
import { ExposedIpcError } from '../ipc/errors'
import type { Logger } from '../services/logger'
import { GmailAuthError } from './auth-error'
import { hasRequiredScope, type GmailAuth } from './gmail-auth'
import { GmailApiError, type GmailClient } from './gmail-client'
import { createNewMailDetector } from './new-mail'
import type { TokenStore } from './token-store'

/** Unread count rhythm, in every notch mode (new-mail alerts show over mini and hidden too). */
export const GMAIL_TICK_MS = 60_000
/** Waits after consecutive network / 5xx / 429 failures: 1 → 2 → 4 → 5 min (max). */
export const GMAIL_BACKOFF_MS = [60_000, 120_000, 240_000, 300_000] as const
/** Minimum time between two manual refreshes. */
export const GMAIL_MANUAL_REFRESH_MIN_MS = 5_000
/** An access token this close to expiry is refreshed before use. */
const ACCESS_TOKEN_MARGIN_MS = 60_000
export const GMAIL_INBOX_URL = 'https://mail.google.com/mail/u/0/#inbox'

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
  /** New unread mail while alerts are on; pushed to the notch as `gmail:new-mail`. */
  onNewMail?: (mail: GmailNewMail) => void
  logger: Logger
}

export type GmailSignInResult = 'ok' | 'cancelled' | 'error'

export interface GmailIntegration {
  /** Resolves once the stored token was read (never rejects). */
  readonly ready: Promise<void>
  state(): GmailState
  /** The last recent list (empty without a session); remembered as the list `open` accepts. */
  recent(): Promise<GmailMessage[]>
  /**
   * Starts the rhythm (main calls it once the IPC targets exist). It then runs whenever there is a
   * session, in every notch mode: the capsule's mode never pauses it nor resets the new-mail baseline.
   */
  start(): void
  setViewOpen(open: boolean): void
  refresh(): void
  open(id?: string): void
  /**
   * Reads a message shown in the notch (last list, the open message or the last alert) as plain
   * text and remembers it as the open message. Refusals and failures are ExposedIpcError.
   */
  message(id: string): Promise<GmailMessageDetail>
  /** Marks a shown message as read, then queries at once. */
  markRead(id: string): Promise<void>
  /** Deletes a shown message permanently, forgets it, then queries at once. */
  remove(id: string): Promise<void>
  /** Opens link `index` of the open message in the browser; anything else is refused. */
  openLink(id: string, index: number): void
  /** The reader closed: forgets the open message's body and links (list ids stay shown). */
  closeMessage(): void
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

type GmailAction = 'message' | 'mark-read' | 'delete'

/**
 * Gmail state machine for main: loads the stored token, polls the unread count every 60 s whatever
 * the notch shows (plus the recent list while the view is open), backs off on network
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
  /** The message being read in the notch (its links only live while it is open). */
  /** The message being read: its thread (null until the read finishes) and its links. */
  let opened: { id: string; threadId: string | null; links: GmailLink[] } | null = null
  /** Bumped whenever the open message is forgotten: a read that finishes later is not remembered. */
  let openSeq = 0
  /** Id of the last new-mail alert: the notch may open it. */
  let alertId: string | null = null
  /** Why the session is expired (`scope`: the token lacks the full mail permission). */
  let reason: GmailState['reason'] = null
  /** Reset only with the session (sign-in, sign-out, client change); never by the notch mode. */
  const detector = createNewMailDetector()

  let refreshToken: string | null = null
  let access: { token: string; expiresAt: number } | null = null
  let refreshing: { generation: number; run: Promise<string> } | null = null

  /** Bumped whenever the session changes (sign-in, sign-out, new client): stale results are dropped. */
  let generation = 0
  let session: { auth: GmailAuth; client: GmailClient | null; clientGeneration: number } | null = null

  let started = false
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

  const state = (): GmailState => ({
    status,
    account,
    unread,
    updatedAt,
    persistent: tokenStore.persistent,
    reason: status === 'expired' ? reason : null,
  })

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

  /** Forgets the message being read: its body and links are gone from main. */
  const forgetOpen = () => {
    openSeq++
    opened = null
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
    forgetOpen()
    alertId = null
    reason = null
    detector.reset()
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
        if (next.scope !== undefined && !hasRequiredScope(next.scope)) {
          // A milestone-1 session (gmail.readonly): nothing more is asked until the user signs in again.
          reason = 'scope'
          throw new GmailAuthError('denied')
        }
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
    if (!started || disposed) return
    timer = timers.setTimeout(() => {
      timer = null
      void poll()
    }, ms)
  }

  const canPoll = () => !disposed && started && refreshToken !== null && (status === 'ok' || status === 'offline')

  /** A result that arrives after the session changed, or while signing in, is dropped. */
  const isStale = (startedIn: number) => startedIn !== generation || disposed || status === 'signing-in'

  /** The session is dead (revoked, or without the needed permission): stop asking until a new sign-in. */
  const expire = (error: unknown) => {
    log.warn('Gmail session expired', { code: errorCode(error), ...(reason === null ? {} : { reason }) })
    // Keep the refresh token out of use: nothing is asked until the user signs in again.
    clearTimer()
    access = null
    messages = []
    sent = []
    forgetOpen()
    alertId = null
    status = 'expired'
    publish()
  }

  /** Alerts the notch about new unread mail (the newest one), unless alerts are off. */
  const announce = async (startedIn: number, fresh: readonly string[]): Promise<void> => {
    const alerts = options.settings.get().gmail.alerts
    const id = fresh[0]
    if (!alerts.enabled || !options.onNewMail || id === undefined) return
    let mail: GmailNewMail = { count: fresh.length, id }
    if (!alerts.hideContent) {
      try {
        const summary = await getClient().summary(id)
        if (isStale(startedIn)) return
        if (summary === null) return // gone before it could be shown
        mail = { ...mail, from: summary.from, subject: summary.subject }
      } catch (error) {
        if (isStale(startedIn)) return
        // The alert still goes out, without sender or subject.
        log.warn('Gmail new-mail details failed', { code: errorCode(error) })
      }
    }
    if (isStale(startedIn)) return
    alertId = id
    log.info('Gmail new mail', { count: mail.count })
    options.onNewMail(mail)
  }

  const runPoll = async (startedIn: number, withRecent: boolean): Promise<void> => {
    try {
      const client = getClient()
      const nextAccount = account ?? (await client.profile())
      const ids = await client.unreadIds()
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
      unread = Math.min(ids.length, GMAIL_UNREAD_CAP)
      updatedAt = new Date(now()).toISOString()
      if (list) messages = list
      failures = 0
      status = 'ok'
      publish()
      schedule(GMAIL_TICK_MS)
      const fresh = detector.observe(ids)
      if (fresh.length > 0) void announce(startedIn, fresh)
    } catch (error) {
      if (isStale(startedIn)) return
      if (isSessionDead(error)) {
        expire(error)
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

  /** After an action: a fresh count and list now, past the manual-refresh floor. */
  const pollNow = () => {
    void afterInFlight().then(() => poll())
  }

  const isShown = (id: string) => sent.some((m) => m.id === id) || opened?.id === id || alertId === id

  /** main trusts no id from the renderer: only messages it showed to the notch. */
  const requireShown = (action: GmailAction | 'open-link', id: string) => {
    if (isShown(id)) return
    log.warn('Refused a Gmail action on a message not shown in the notch', { action })
    throw new ExposedIpcError('INVALID_INPUT', 'Unknown message')
  }

  /** Generation of a usable session, or UNAVAILABLE. */
  const activeSession = (): number => {
    if (disposed || refreshToken === null || (status !== 'ok' && status !== 'offline')) {
      throw new ExposedIpcError('UNAVAILABLE', 'Gmail is not connected')
    }
    return generation
  }

  /** Turns a failed action into a code the notch can show; never the message data. */
  const actionFailed = (action: GmailAction, startedIn: number, error: unknown): never => {
    if (isStale(startedIn)) throw new ExposedIpcError('UNAVAILABLE', 'Gmail session changed')
    if (error instanceof GmailApiError && error.code === 'not-found') throw new ExposedIpcError('NOT_FOUND', 'The message no longer exists')
    if (isSessionDead(error)) {
      expire(error)
      throw new ExposedIpcError('UNAVAILABLE', 'Gmail session expired')
    }
    const code = errorCode(error)
    log.warn('Gmail action failed', { action, code })
    throw new ExposedIpcError('UNAVAILABLE', `Gmail request failed: ${code}`)
  }

  const act = async (action: 'mark-read' | 'delete', id: string): Promise<void> => {
    await ready
    requireShown(action, id)
    const startedIn = activeSession()
    try {
      const client = getClient()
      await (action === 'delete' ? client.remove(id) : client.markRead(id))
    } catch (error) {
      actionFailed(action, startedIn, error)
    }
    if (isStale(startedIn)) throw new ExposedIpcError('UNAVAILABLE', 'Gmail session changed')
    if (action === 'delete') {
      // Gone for good: no later call may name it.
      sent = sent.filter((m) => m.id !== id)
      messages = messages.filter((m) => m.id !== id)
      if (opened?.id === id) forgetOpen()
      if (alertId === id) alertId = null
    }
    log.info('Gmail action done', { action })
    pollNow()
  }

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

    start() {
      if (started) return
      started = true
      void poll()
    },

    setViewOpen(open) {
      const opening = open && !viewOpen
      viewOpen = open
      if (!open) forgetOpen()
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
        // The last list, then the open message (an alert can open one that is not listed); a shown id
        // whose thread is unknown opens the inbox. Anything else was never shown: refused.
        const threadId = sent.find((m) => m.id === id)?.threadId ?? (opened?.id === id ? opened.threadId : null)
        if (threadId === null && !isShown(id)) {
          log.warn('Refused to open a message not shown in the notch')
          return
        }
        if (threadId !== null) url = `${GMAIL_INBOX_URL}/${encodeURIComponent(threadId)}`
      }
      Promise.resolve()
        .then(() => options.openExternal(url))
        .catch((error: unknown) => log.warn('Could not open Gmail in the browser', { error: errorCode(error) }))
    },

    async message(id) {
      await ready
      requireShown('message', id)
      const startedIn = activeSession()
      // A new read replaces the open message; the id stays shown while it loads (and for a retry).
      forgetOpen()
      const seq = openSeq
      opened = { id, threadId: null, links: [] }
      let detail: GmailMessageDetail
      try {
        detail = await getClient().message(id)
      } catch (error) {
        return actionFailed('message', startedIn, error)
      }
      if (isStale(startedIn)) throw new ExposedIpcError('UNAVAILABLE', 'Gmail session changed')
      if (seq === openSeq) opened = { id, threadId: detail.threadId, links: detail.links }
      return detail
    },

    markRead: (id) => act('mark-read', id),

    remove: (id) => act('delete', id),

    openLink(id, index) {
      const link = opened?.id === id ? opened.links[index] : undefined
      if (!link || !isWebUrl(link.url)) {
        log.warn('Refused to open a link outside the open message')
        throw new ExposedIpcError('INVALID_INPUT', 'Unknown link')
      }
      Promise.resolve()
        .then(() => options.openExternal(link.url))
        .catch((error: unknown) => log.warn('Could not open a mail link in the browser', { error: errorCode(error) }))
    },

    closeMessage() {
      forgetOpen()
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
        if (result.scope !== undefined && !hasRequiredScope(result.scope)) {
          // The user did not grant full mail access: this token is of no use, and neither is the old one.
          log.warn('Gmail sign-in lacks the full mail permission')
          resetSession()
          reason = 'scope'
          status = 'expired'
          publish()
          await clearStoredToken()
          return 'error'
        }
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
