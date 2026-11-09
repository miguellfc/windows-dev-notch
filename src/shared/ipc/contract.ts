import { z } from 'zod'
import { appInfoSchema } from '../app-info'
import { settingsPatchSchema, settingsSchema } from '../settings/schema'
import type { ChannelName } from './channels'

interface ChannelContract {
  readonly input: z.ZodType
  readonly output: z.ZodType
}

/** Single source of truth for every IPC channel: what it accepts and what it returns. */
export const contract = {
  'app:get-info': { input: z.undefined(), output: appInfoSchema },
  'settings:get': { input: z.undefined(), output: settingsSchema },
  'settings:update': { input: settingsPatchSchema, output: settingsSchema },
} as const satisfies Record<ChannelName, ChannelContract>

export type Contract = typeof contract
export type ContractInput<C extends ChannelName> = z.output<Contract[C]['input']>
export type ContractOutput<C extends ChannelName> = z.output<Contract[C]['output']>
