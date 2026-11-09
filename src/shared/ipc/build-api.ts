import type { NotchApi } from './api'
import { channels } from './channels'
import { err } from './result'

export type Invoke = (channel: string, input?: unknown) => Promise<unknown>

/**
 * Builds the frozen `window.notch` object: one method per known channel, nothing else.
 * Transport failures (window closing, missing handler) also resolve to a Result,
 * so renderer code never has to handle a rejected promise.
 */
export function buildApi(invoke: Invoke): NotchApi {
  const api = Object.fromEntries(
    Object.entries(channels).map(([group, methods]) => [
      group,
      Object.freeze(
        Object.fromEntries(
          Object.entries(methods).map(([name, channel]) => [
            name,
            (input?: unknown) => invoke(channel, input).catch(() => err('INTERNAL', 'IPC call failed')),
          ]),
        ),
      ),
    ]),
  )
  return Object.freeze(api) as unknown as NotchApi
}
