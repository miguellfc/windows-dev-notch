import type { z } from 'zod'
import type { ChannelName, channels } from './channels'
import type { Contract } from './contract'
import type { Result } from './result'

type Channels = typeof channels
type RendererInput<C extends ChannelName> = z.input<Contract[C]['input']>
type RendererOutput<C extends ChannelName> = z.output<Contract[C]['output']>

type Method<C extends ChannelName> =
  RendererInput<C> extends undefined
    ? () => Promise<Result<RendererOutput<C>>>
    : (input: RendererInput<C>) => Promise<Result<RendererOutput<C>>>

/** The API the preload exposes as `window.notch`, derived from the contract. */
export type NotchApi = {
  readonly [Group in keyof Channels]: {
    readonly [Name in keyof Channels[Group]]: Channels[Group][Name] extends ChannelName
      ? Method<Channels[Group][Name]>
      : never
  }
}
