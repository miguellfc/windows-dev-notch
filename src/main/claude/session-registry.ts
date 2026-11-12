import type { HookEvent } from '../../shared/claude/hook-events'
import type { ClaudeSession, ClaudeSessionStatus } from '../../shared/claude/types'

export const DEFAULT_IDLE_AFTER_MS = 1_800_000

export type SessionRegistryOptions = {
  now: () => number
  idleAfterMs?: number
}

export type SessionRegistry = {
  apply: (event: HookEvent) => void
  sessions: () => ClaudeSession[]
  /** Idle after the quiet window; only sessions in `heldSessions` (a request held by the broker) are exempt. */
  tick: (heldSessions?: ReadonlySet<string>) => boolean
  dismiss: (id: string) => boolean
  /** The session's name; for one not seen yet, the last segment of `cwd` (else the id prefix). */
  nameOf: (id: string, cwd?: string) => string
  /** Something is held for the user (permission or question): `waiting`, creating the session if new. True if it changed. */
  markWaiting: (id: string, cwd?: string) => boolean
  /** A pending permission went away (decided, dropped or released): leave `waiting`. */
  resolveWaiting: (id: string) => boolean
}

type Entry = ClaudeSession & { resumeStatus: ClaudeSessionStatus }

const fallbackName = (id: string): string => id.slice(0, 8)

const nameFromCwd = (cwd: string | undefined): string | undefined =>
  cwd?.split(/[\\/]/).filter((part) => part.length > 0).pop()

export const createSessionRegistry = (options: SessionRegistryOptions): SessionRegistry => {
  const idleAfterMs = options.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS
  const entries = new Map<string, Entry>()

  const nextStatus = (event: HookEvent, current: ClaudeSessionStatus | undefined): ClaudeSessionStatus => {
    switch (event.name) {
      case 'PermissionRequest':
        return 'waiting'
      case 'Notification':
        return event.notificationType === 'permission_prompt' ? 'waiting' : (current ?? 'working')
      case 'Stop':
        return 'done'
      case 'SubagentStop':
        return current === 'done' ? 'done' : 'working'
      case 'StopFailure':
        return 'error'
      default:
        // UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, SubagentStart, PermissionDenied
        return 'working'
    }
  }

  const apply = (event: HookEvent): void => {
    if (event.name === 'SessionEnd') {
      entries.delete(event.sessionId)
      return
    }
    const existing = entries.get(event.sessionId)
    // Any event revives an idle session to the status it had before going idle.
    const current = existing?.status === 'idle' ? existing.resumeStatus : existing?.status
    const status = nextStatus(event, current)
    const name = nameFromCwd(event.cwd) ?? existing?.name ?? fallbackName(event.sessionId)
    entries.set(event.sessionId, {
      id: event.sessionId,
      name,
      status,
      updatedAt: options.now(),
      resumeStatus: status,
    })
  }

  const sessions = (): ClaudeSession[] =>
    [...entries.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ id, name, status, updatedAt }) => ({ id, name, status, updatedAt }))

  const tick = (heldSessions: ReadonlySet<string> = new Set()): boolean => {
    const now = options.now()
    let changed = false
    for (const entry of entries.values()) {
      // A held permission can legitimately outlast the idle window (hook timeout 3600 s); a
      // `waiting` with nothing held (e.g. only a permission_prompt notification) cannot.
      if (entry.status !== 'idle' && !heldSessions.has(entry.id) && now - entry.updatedAt >= idleAfterMs) {
        entry.resumeStatus = entry.status
        entry.status = 'idle'
        changed = true
      }
    }
    return changed
  }

  const dismiss = (id: string): boolean => {
    const entry = entries.get(id)
    if (entry?.status !== 'idle') return false
    entries.delete(id)
    return true
  }

  const nameOf = (id: string, cwd?: string): string => entries.get(id)?.name ?? nameFromCwd(cwd) ?? fallbackName(id)

  const markWaiting = (id: string, cwd?: string): boolean => {
    const entry = entries.get(id)
    if (entry?.status === 'waiting') return false
    entries.set(id, {
      id,
      name: entry?.name ?? nameFromCwd(cwd) ?? fallbackName(id),
      status: 'waiting',
      updatedAt: options.now(),
      resumeStatus: 'waiting',
    })
    return true
  }

  const resolveWaiting = (id: string): boolean => {
    const entry = entries.get(id)
    if (entry?.status !== 'waiting') return false
    entry.status = 'working'
    entry.resumeStatus = 'working'
    entry.updatedAt = options.now()
    return true
  }

  return { apply, sessions, tick, dismiss, nameOf, markWaiting, resolveWaiting }
}
