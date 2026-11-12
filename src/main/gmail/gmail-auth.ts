import { createHash, randomBytes } from 'node:crypto'
import { tokenResponseSchema } from '../../shared/gmail/schema'
import { GmailAuthError } from './auth-error'
import { startLoopback, type Loopback } from './loopback'

export { GmailAuthError, type GmailAuthErrorCode } from './auth-error'

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_OAUTH_BASE = 'https://oauth2.googleapis.com'
/** A token exchange, refresh or revoke that has not answered by then fails as `network`. */
export const GMAIL_AUTH_TIMEOUT_MS = 30_000

const base64url = (buffer: Buffer): string => buffer.toString('base64url')

export const pkceChallenge = (verifier: string): string => base64url(createHash('sha256').update(verifier).digest())

/** PKCE (S256) verifier and challenge plus an anti-CSRF `state`. */
export function createPkce(random: (n: number) => Buffer = randomBytes): {
  verifier: string
  challenge: string
  state: string
} {
  const verifier = base64url(random(32))
  return { verifier, challenge: pkceChallenge(verifier), state: base64url(random(16)) }
}

export type GmailFetch = (url: string, init?: RequestInit) => Promise<Response>

export interface GmailAuthOptions {
  fetch: GmailFetch
  openExternal: (url: string) => Promise<void> | void
  /** Origin serving `/token` and `/revoke` (Google: `https://oauth2.googleapis.com`). */
  oauthBase: string
  clientId: string
  clientSecret: string
  /** Consent screen URL; defaults to Google's. */
  authUrl?: string
  now?: () => number
  /** Signal that aborts after `ms`; defaults to `AbortSignal.timeout` (injectable for tests). */
  timeoutSignal?: (ms: number) => AbortSignal
}

export interface SignInResult {
  refreshToken: string
  accessToken: string
  expiresAt: number
}

export interface GmailAuth {
  signIn(): Promise<SignInResult>
  cancel(): void
  refresh(refreshToken: string): Promise<{ accessToken: string; expiresAt: number }>
  revoke(token: string): Promise<void>
}

export function createGmailAuth(options: GmailAuthOptions): GmailAuth {
  const { fetch: doFetch, openExternal, oauthBase, clientId, clientSecret, authUrl = GOOGLE_AUTH_URL } = options
  const now = options.now ?? Date.now
  const timeoutSignal = options.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms))

  interface Session {
    cancelled: boolean
    abort: AbortController
    loopback?: Loopback
  }
  let current: Session | undefined

  const cancelSession = (session: Session | undefined): void => {
    if (!session) return
    session.cancelled = true
    session.abort.abort()
    session.loopback?.close()
  }

  /**
   * POST with a 30 s timeout so a stalled request can never hang polling or sign-out. Any failure,
   * the timeout included, is `network`; callers map a real cancel to `cancelled` themselves.
   */
  const postForm = async (path: string, fields: Record<string, string>, signal?: AbortSignal): Promise<Response> => {
    const timeout = timeoutSignal(GMAIL_AUTH_TIMEOUT_MS)
    try {
      return await doFetch(`${oauthBase}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
    } catch {
      throw new GmailAuthError('network')
    }
  }

  const readTokens = async (response: Response, failure: 'denied' | 'invalid-response') => {
    if (response.status >= 500 || response.status === 429) throw new GmailAuthError('network')
    if (!response.ok) throw new GmailAuthError(failure)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new GmailAuthError('invalid-response')
    }
    const parsed = tokenResponseSchema.safeParse(body)
    if (!parsed.success) throw new GmailAuthError('invalid-response')
    return parsed.data
  }

  return {
    async signIn() {
      cancelSession(current)
      const session: Session = { cancelled: false, abort: new AbortController() }
      current = session
      try {
        const { verifier, challenge, state } = createPkce()
        const loopback = await startLoopback({ state })
        session.loopback = loopback
        if (session.cancelled) loopback.close()

        const url = new URL(authUrl)
        url.search = new URLSearchParams({
          client_id: clientId,
          redirect_uri: loopback.redirectUri,
          response_type: 'code',
          scope: GMAIL_SCOPE,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
          access_type: 'offline',
          prompt: 'consent',
        }).toString()

        if (!session.cancelled) {
          try {
            await openExternal(url.toString())
          } catch {
            loopback.close()
            throw new GmailAuthError('network')
          }
        }

        const code = await loopback.code
        let tokens: Awaited<ReturnType<typeof readTokens>>
        try {
          tokens = await readTokens(
            await postForm(
              '/token',
              {
                grant_type: 'authorization_code',
                code,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: loopback.redirectUri,
                code_verifier: verifier,
              },
              session.abort.signal,
            ),
            'invalid-response',
          )
        } catch (error) {
          if (session.cancelled) throw new GmailAuthError('cancelled')
          throw error
        }
        if (session.cancelled) throw new GmailAuthError('cancelled')
        if (!tokens.refresh_token) throw new GmailAuthError('invalid-response')
        return {
          refreshToken: tokens.refresh_token,
          accessToken: tokens.access_token,
          expiresAt: now() + tokens.expires_in * 1000,
        }
      } finally {
        session.loopback?.close()
        if (current === session) current = undefined
      }
    },

    cancel() {
      cancelSession(current)
    },

    async refresh(refreshToken) {
      const tokens = await readTokens(
        await postForm('/token', {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }),
        'denied',
      )
      return { accessToken: tokens.access_token, expiresAt: now() + tokens.expires_in * 1000 }
    },

    /** Best effort: the session is closed locally even when Google cannot be reached. */
    async revoke(token) {
      try {
        await postForm('/revoke', { token })
      } catch {
        // Nothing to do: the caller discards the token either way.
      }
    },
  }
}
