export type GmailAuthErrorCode = 'cancelled' | 'timeout' | 'denied' | 'network' | 'invalid-response'

/** Failure of the OAuth flow. Carries only a code, never tokens or response bodies. */
export class GmailAuthError extends Error {
  readonly code: GmailAuthErrorCode

  constructor(code: GmailAuthErrorCode) {
    super(`Gmail auth failed: ${code}`)
    this.name = 'GmailAuthError'
    this.code = code
  }
}
