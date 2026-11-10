import { z } from 'zod'

export const HOOK_EVENT_NAMES = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'SessionEnd',
] as const

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number]

/**
 * Sanitised view of a Claude Code hook payload. It deliberately carries no
 * prompt, message, tool_response or last_assistant_message; `preview` exists
 * only for PermissionRequest and must stay in memory.
 */
export type HookEvent = {
  name: HookEventName
  sessionId: string
  cwd?: string
  toolName?: string
  /** Identity of one tool call (PreToolUse, PostToolUse, PostToolUseFailure, PermissionDenied). */
  toolUseId?: string
  /** Set when the event comes from a subagent. */
  agentId?: string
  notificationType?: string
  preview?: string
  /** The sanitised preview was longer than `PREVIEW_MAX_CHARS` and was cut. */
  previewTruncated?: boolean
  /** Length of the whole sanitised preview, before the cut. */
  previewLength?: number
  reason?: string
}

export const PREVIEW_MAX_CHARS = 2_000
export const TOOL_NAME_MAX_CHARS = 64

const TOOL_CALL_EVENTS: ReadonlySet<HookEventName> = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionDenied',
])

// Optional string fields tolerate a wrong type by being dropped, not by rejecting the event.
const optionalString = z.string().optional().catch(undefined)

const hookPayloadSchema = z.looseObject({
  session_id: z.string().min(1),
  hook_event_name: z.enum(HOOK_EVENT_NAMES),
  cwd: optionalString,
  tool_name: optionalString,
  tool_use_id: optionalString,
  agent_id: optionalString,
  notification_type: optionalString,
  reason: optionalString,
  tool_input: z.unknown().optional(),
})

// C0/C1 controls except \t and \n.
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
// Unicode format characters: bidi overrides/isolates, zero-width, BOM, soft hyphen...
const FORMAT_CHARS = /\p{Cf}/gu
// U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR, built from code points (they are line terminators in source).
const LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, 'g')
// Long runs of spaces/tabs could push the rest of a line out of view.
const LONG_BLANK_RUN = /[ \t]{64,}/g
const BLANK_LINE = /^\s*$/
const ELLIPSIS = '⋯'

/** Display-safe text: no controls or format characters, and no padding that could hide the payload. */
const sanitizeText = (text: string): string => {
  const cleaned = text
    .replace(LINE_SEPARATORS, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(FORMAT_CHARS, '')
    .replace(LONG_BLANK_RUN, ` ${ELLIPSIS} `)
  const out: string[] = []
  let blanks: string[] = []
  const flush = () => {
    if (blanks.length >= 3) out.push(ELLIPSIS)
    else out.push(...blanks)
    blanks = []
  }
  for (const line of cleaned.split('\n')) {
    if (BLANK_LINE.test(line)) {
      blanks.push(line)
      continue
    }
    flush()
    out.push(line)
  }
  flush()
  return out.join('\n')
}

type Preview = { text: string; truncated: boolean; length: number }

const cut = (text: string): Preview => ({
  text: text.slice(0, PREVIEW_MAX_CHARS),
  truncated: text.length > PREVIEW_MAX_CHARS,
  length: text.length,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The command for shell tools; everything else shows its whole input (Write content, MCP arguments...). */
const previewFromToolInput = (toolInput: unknown): Preview | undefined => {
  if (toolInput === undefined || toolInput === null) return undefined
  if (isRecord(toolInput) && typeof toolInput.command === 'string' && toolInput.command.length > 0) {
    return cut(sanitizeText(toolInput.command))
  }
  try {
    const json = JSON.stringify(toolInput)
    return json === undefined ? undefined : cut(sanitizeText(json))
  } catch {
    return undefined
  }
}

export const parseHookEvent = (raw: unknown): HookEvent | null => {
  const parsed = hookPayloadSchema.safeParse(raw)
  if (!parsed.success) return null
  const data = parsed.data
  const event: HookEvent = { name: data.hook_event_name, sessionId: data.session_id }
  if (data.cwd !== undefined) event.cwd = data.cwd
  if (data.tool_name !== undefined) {
    event.toolName = sanitizeText(data.tool_name).replace(/[\n\t]/g, ' ').slice(0, TOOL_NAME_MAX_CHARS)
  }
  if (data.tool_use_id !== undefined && TOOL_CALL_EVENTS.has(data.hook_event_name)) event.toolUseId = data.tool_use_id
  if (data.agent_id !== undefined) event.agentId = data.agent_id
  if (data.hook_event_name === 'Notification' && data.notification_type !== undefined) {
    event.notificationType = data.notification_type
  }
  if (data.hook_event_name === 'SessionEnd' && data.reason !== undefined) event.reason = data.reason
  if (data.hook_event_name === 'PermissionRequest') {
    const preview = previewFromToolInput(data.tool_input)
    if (preview !== undefined) {
      event.preview = preview.text
      event.previewTruncated = preview.truncated
      event.previewLength = preview.length
    }
  }
  return event
}
