import { z } from 'zod'
import { appInfoSchema } from '../app-info'
import { integrationIds } from '../integrations/registry'
import { settingsPatchSchema, settingsSchema } from '../settings/schema'
import type { ChannelName, EventName } from './channels'

interface ChannelContract {
  readonly input: z.ZodType
  readonly output: z.ZodType
}

export const notchModeSchema = z.enum(['compact', 'peek', 'expanded', 'terminal', 'mini', 'hidden'])

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
} as const satisfies Record<ChannelName, ChannelContract>

/** Payloads of the events the main process pushes to renderers. */
export const eventContract = {
  'notch:mode-changed': notchModeSchema,
  'settings:changed': settingsSchema,
  'terminal:data': z.string(),
  'terminal:exit': z.strictObject({ exitCode: z.int() }),
} as const satisfies Record<EventName, z.ZodType>

export type Contract = typeof contract
export type ContractInput<C extends ChannelName> = z.output<Contract[C]['input']>
export type ContractOutput<C extends ChannelName> = z.output<Contract[C]['output']>
export type EventPayload<E extends EventName> = z.output<(typeof eventContract)[E]>
