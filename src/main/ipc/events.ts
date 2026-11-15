import type { EventName } from '../../shared/ipc/channels'
import { eventContract, type EventPayload } from '../../shared/ipc/contract'
import type { Logger } from '../services/logger'

/** The part of a WebContents needed to push an event. */
export interface EventTarget {
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
}

/** Pushes an event to renderers, validating the payload against the contract first. */
export function emitEvent<E extends EventName>(
  targets: readonly EventTarget[],
  event: E,
  payload: EventPayload<E>,
  logger: Logger,
): void {
  const parsed = eventContract[event].safeParse(payload)
  if (!parsed.success) {
    logger.child('ipc').error('Refused to emit an event outside the contract', { event })
    return
  }
  for (const target of targets) {
    if (!target.isDestroyed()) target.send(event, parsed.data)
  }
}
