import type { HookEvent, HookEventName } from '../../shared/claude/hook-events'
import type { PendingPermission } from '../../shared/claude/types'

/** Transport-agnostic handle on a held hook response (the HTTP bridge implements it). */
export interface PendingReply {
  /** When the transport received the request (ms, before its body was read), if it knows. */
  readonly arrivedAt?: number
  send(body: string | null): void
  onClose(cb: () => void): void
}

export type PermissionBrokerOptions = {
  newId: () => string
  now: () => number
  sessionName: (id: string) => string
  onChange: () => void
}

export type PermissionBroker = {
  hold(e: HookEvent, reply: PendingReply): void
  decide(id: string, d: 'allow' | 'deny'): boolean
  observe(e: HookEvent): void
  releaseAll(): void
  pending(): PendingPermission[]
}

type Entry = {
  info: PendingPermission
  reply: PendingReply
  /** tool_use_id of the PreToolUse this request belongs to, when one could be found. */
  toolUseId: string | null
}

/** A PreToolUse whose PostToolUse / PostToolUseFailure / PermissionDenied has not arrived yet. */
type OpenCall = { toolUseId: string; toolName: string | undefined; agentId: string | undefined }

// The end of a tool call: releases the request bound to that call (or, unbound, one of the same tool).
const TOOL_END_EVENTS: ReadonlySet<HookEventName> = new Set(['PostToolUse', 'PostToolUseFailure', 'PermissionDenied'])
// The turn is over (or was interrupted): nothing of the session can still be waiting on us.
// Notification is excluded on purpose: permission_prompt arrives ~6 s after the request for the same prompt.
const SESSION_END_EVENTS: ReadonlySet<HookEventName> = new Set(['Stop', 'StopFailure', 'UserPromptSubmit', 'SessionEnd'])

/** Bounds the per-session memory of unfinished tool calls (a lost PostToolUse must not grow it forever). */
const MAX_OPEN_CALLS = 256

const decisionBody = (behavior: 'allow' | 'deny'): string =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior } } })

export const createPermissionBroker = (options: PermissionBrokerOptions): PermissionBroker => {
  // Map keeps insertion (arrival) order.
  const entries = new Map<string, Entry>()
  const openCalls = new Map<string, OpenCall[]>()

  // Removing before sending makes a later onClose for the same reply a no-op.
  const settle = (id: string, body: string | null): void => {
    const entry = entries.get(id)
    if (!entry) return
    entries.delete(id)
    entry.reply.send(body)
    options.onChange()
  }

  const releaseWhere = (match: (entry: Entry) => boolean): void => {
    for (const [id, entry] of [...entries]) if (match(entry)) settle(id, null)
  }

  /** The most recent unfinished call of the same tool (and agent, for a subagent request). */
  const bindToolCall = (e: HookEvent): string | null => {
    const calls = openCalls.get(e.sessionId) ?? []
    for (let i = calls.length - 1; i >= 0; i -= 1) {
      const call = calls[i]!
      if (call.toolName !== e.toolName) continue
      if (e.agentId !== undefined && call.agentId !== e.agentId) continue
      return call.toolUseId
    }
    return null
  }

  const trackToolCalls = (e: HookEvent): void => {
    if (e.name === 'PreToolUse' && e.toolUseId !== undefined) {
      const calls = openCalls.get(e.sessionId) ?? []
      calls.push({ toolUseId: e.toolUseId, toolName: e.toolName, agentId: e.agentId })
      if (calls.length > MAX_OPEN_CALLS) calls.shift()
      openCalls.set(e.sessionId, calls)
    } else if (TOOL_END_EVENTS.has(e.name) && e.toolUseId !== undefined) {
      const calls = openCalls.get(e.sessionId)
      const index = calls?.findIndex((call) => call.toolUseId === e.toolUseId) ?? -1
      if (calls && index >= 0) calls.splice(index, 1)
    } else if (SESSION_END_EVENTS.has(e.name)) {
      openCalls.delete(e.sessionId)
    }
  }

  return {
    hold(e, reply) {
      const id = options.newId()
      entries.set(id, {
        info: {
          id,
          sessionId: e.sessionId,
          sessionName: options.sessionName(e.sessionId),
          toolName: e.toolName ?? '',
          preview: e.preview ?? '',
          previewTruncated: e.previewTruncated ?? false,
          previewLength: e.previewLength ?? (e.preview ?? '').length,
          receivedAt: reply.arrivedAt ?? options.now(),
        },
        reply,
        toolUseId: bindToolCall(e),
      })
      reply.onClose(() => {
        if (entries.delete(id)) options.onChange()
      })
      options.onChange()
    },

    decide(id, d) {
      if (!entries.has(id)) return false
      settle(id, decisionBody(d))
      return true
    },

    observe(e) {
      trackToolCalls(e)
      if (SESSION_END_EVENTS.has(e.name)) {
        releaseWhere((entry) => entry.info.sessionId === e.sessionId)
      } else if (TOOL_END_EVENTS.has(e.name)) {
        releaseWhere((entry) =>
          entry.toolUseId !== null
            ? e.toolUseId !== undefined && entry.toolUseId === e.toolUseId && entry.info.sessionId === e.sessionId
            : entry.info.sessionId === e.sessionId && e.toolName !== undefined && entry.info.toolName === e.toolName,
        )
      }
      // PreToolUse, Notification, Subagent*, PermissionRequest: never release.
    },

    releaseAll() {
      for (const id of [...entries.keys()]) settle(id, null)
    },

    pending() {
      return [...entries.values()].map((entry) => ({ ...entry.info }))
    },
  }
}
