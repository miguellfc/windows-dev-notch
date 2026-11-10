export type ClaudeSessionStatus = 'working' | 'waiting' | 'done' | 'error' | 'idle'

export type ClaudeSession = {
  id: string
  name: string
  status: ClaudeSessionStatus
  updatedAt: number
}

export type PendingPermission = {
  id: string
  sessionId: string
  sessionName: string
  toolName: string
  preview: string
  /** The preview was cut at PREVIEW_MAX_CHARS: Allow stays disabled (decide in Claude instead). */
  previewTruncated: boolean
  /** Length of the whole sanitised preview, before the cut. */
  previewLength: number
  receivedAt: number
}

export type ClaudeConnection = 'connected' | 'waiting-for-events' | 'not-installed' | 'error'

/** Our hooks in Claude's settings.json; `unknown` when they cannot be checked (no bridge config). */
export type ClaudeHooksStatus = 'installed' | 'outdated' | 'missing' | 'unknown'

/** Why the connection is in `error`, when it is known and actionable. */
export type ClaudeConnectionErrorReason = 'port-in-use'

/** What happened to installed hooks after rotating the token or the port. */
export type ClaudeRotateOutcome = { hooks: 'reinstalled' | 'not-installed' | 'reinstall-failed' }

/** Everything the renderers know about Claude Code. Never carries the bridge token. */
export type ClaudeState = {
  connection: ClaudeConnection
  /** Only with `connection: 'error'`: another program holds our port and could receive the permission requests. */
  reason?: ClaudeConnectionErrorReason | undefined
  hooks: ClaudeHooksStatus
  sessions: ClaudeSession[]
  pending: PendingPermission[]
}
