import { z } from 'zod'
import { appInfoSchema } from '../app-info'
import type { ClaudeRotateOutcome, ClaudeState } from '../claude/types'
import { integrationIds } from '../integrations/registry'
import { settingsPatchSchema, settingsSchema } from '../settings/schema'
import type { ChannelName, EventName } from './channels'

interface ChannelContract {
  readonly input: z.ZodType
  readonly output: z.ZodType
}

export const notchModeSchema = z.enum(['compact', 'peek', 'alert', 'expanded', 'terminal', 'permission', 'mini', 'hidden'])

export const runtimeSchema = z.strictObject({
  isPackaged: z.boolean(),
  shortcutRegistered: z.boolean(),
})

/** Largest chunk the renderer may send in one terminal write; bigger pastes are split. */
export const TERMINAL_INPUT_MAX = 65_536

export const terminalOpenSchema = z.strictObject({
  state: z.enum(['running', 'exited']),
  exitCode: z.int().optional(),
  snapshot: z.string(),
  shell: z.string(),
})

export const claudeStateSchema = z.strictObject({
  connection: z.enum(['connected', 'waiting-for-events', 'not-installed', 'error']),
  reason: z.literal('port-in-use').optional(),
  hooks: z.enum(['installed', 'outdated', 'missing', 'unknown']),
  sessions: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      status: z.enum(['working', 'waiting', 'done', 'error', 'idle']),
      updatedAt: z.number(),
    }),
  ),
  pending: z.array(
    z.strictObject({
      id: z.string(),
      sessionId: z.string(),
      sessionName: z.string(),
      toolName: z.string(),
      preview: z.string(),
      previewTruncated: z.boolean(),
      previewLength: z.number(),
      receivedAt: z.number(),
    }),
  ),
}) satisfies z.ZodType<ClaudeState>

/** What a token or port rotation did to installed hooks (a failed reinstall is not a success). */
export const claudeRotateSchema = z.strictObject({
  hooks: z.enum(['reinstalled', 'not-installed', 'reinstall-failed']),
}) satisfies z.ZodType<ClaudeRotateOutcome>

const diffSchema = z.array(z.strictObject({ kind: z.enum(['add', 'remove', 'same']), text: z.string() }))
const invalidJsonSchema = z.strictObject({ ok: z.literal(false), reason: z.literal('invalid-json') })

/** Diff of Claude's settings.json with every bridge token masked. */
export const claudeHooksPreviewSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), diff: diffSchema }),
  invalidJsonSchema,
])

export const claudeHooksWriteSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), changed: z.boolean(), diff: diffSchema, backupFile: z.string().optional() }),
  invalidJsonSchema,
])

const none = z.undefined()
const ack = z.null()

/** Single source of truth for every IPC channel: what it accepts and what it returns. */
export const contract = {
  'app:get-info': { input: none, output: appInfoSchema },
  'app:get-runtime': { input: none, output: runtimeSchema },
  'app:open-control-center': { input: none, output: ack },
  'app:hide-notch': { input: none, output: ack },
  'settings:get': { input: none, output: settingsSchema },
  'settings:update': { input: settingsPatchSchema, output: settingsSchema },
  'notch:get-mode': { input: none, output: notchModeSchema },
  'notch:request': { input: z.strictObject({ intent: z.enum(['expand', 'dismiss', 'toggle']) }), output: ack },
  'notch:pointer': { input: z.strictObject({ inside: z.boolean() }), output: ack },
  'notch:settled': { input: none, output: ack },
  'notch:open-integration': { input: z.strictObject({ id: z.enum(integrationIds) }), output: ack },
  'notch:back': { input: none, output: ack },
  'terminal:open': { input: none, output: terminalOpenSchema },
  'terminal:input': { input: z.strictObject({ data: z.string().min(1).max(TERMINAL_INPUT_MAX) }), output: ack },
  'terminal:resize': {
    input: z.strictObject({ cols: z.int().min(2).max(500), rows: z.int().min(1).max(200) }),
    output: ack,
  },
  'claude:get-state': { input: none, output: claudeStateSchema },
  'claude:decide': {
    input: z.strictObject({ requestId: z.uuid(), decision: z.enum(['allow', 'deny']) }),
    output: ack,
  },
  'claude:focus-app': { input: none, output: ack },
  'claude:dismiss-session': { input: z.strictObject({ sessionId: z.string().min(1).max(256) }), output: ack },
  'claude:hooks-preview': { input: none, output: claudeHooksPreviewSchema },
  'claude:hooks-install': { input: none, output: claudeHooksWriteSchema },
  'claude:hooks-uninstall': { input: none, output: claudeHooksWriteSchema },
  'claude:test-connection': { input: none, output: z.strictObject({ ok: z.boolean() }) },
  'claude:rotate-token': { input: none, output: claudeRotateSchema },
  'claude:rotate-port': { input: none, output: claudeRotateSchema },
} as const satisfies Record<ChannelName, ChannelContract>

/** Payloads of the events the main process pushes to renderers. */
export const eventContract = {
  'notch:mode-changed': notchModeSchema,
  'settings:changed': settingsSchema,
  'terminal:data': z.string(),
  'terminal:exit': z.strictObject({ exitCode: z.int() }),
  'claude:state-changed': claudeStateSchema,
} as const satisfies Record<EventName, z.ZodType>

export type Contract = typeof contract
export type ContractInput<C extends ChannelName> = z.output<Contract[C]['input']>
export type ContractOutput<C extends ChannelName> = z.output<Contract[C]['output']>
export type EventPayload<E extends EventName> = z.output<(typeof eventContract)[E]>
