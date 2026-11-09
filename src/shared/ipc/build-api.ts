import type { NotchApi, Unsubscribe } from './api'
import { channels, eventChannels } from './channels'
import { err } from './result'

export type Invoke = (channel: string, input?: unknown) => Promise<unknown>
export type Subscribe = (channel: string, listener: (payload: never) => void) => Unsubscribe

const knownEvents = new Set<string>(Object.values(eventChannels))

const noSubscribe: Subscribe = () => {
  throw new Error('Events are not available in this context')
}

/**
 * Builds the frozen `window.notch` object: one method per known channel, nothing else.
 * Transport failures (window closing, missing handler) also resolve to a Result,
 * so renderer code never has to handle a rejected promise.
 */
export function buildApi(invoke: Invoke, subscribe: Subscribe = noSubscribe): NotchApi {
  const api: Record<string, unknown> = Object.fromEntries(
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
  api['events'] = Object.freeze({
    on: (event: string, listener: (payload: never) => void) => {
      if (!knownEvents.has(event)) throw new Error(`Unknown event: ${event}`)
      return subscribe(event, listener)
    },
  })
  return Object.freeze(api) as unknown as NotchApi
}
