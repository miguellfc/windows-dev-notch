import { describe, expect, it, vi } from 'vitest'
import { emitEvent, type EventTarget } from '../../../src/main/ipc/events'
import { createMemoryLogger } from '../helpers/memory-logger'

const target = (destroyed = false) => {
  const send = vi.fn<(channel: string, payload: unknown) => void>()
  const value: EventTarget = { isDestroyed: () => destroyed, send }
  return Object.assign(value, { send })
}

describe('emitEvent', () => {
  it('sends a validated payload to every live target', () => {
    const a = target()
    const b = target()
    emitEvent([a, b], 'notch:mode-changed', 'expanded', createMemoryLogger())
    expect(a.send).toHaveBeenCalledWith('notch:mode-changed', 'expanded')
    expect(b.send).toHaveBeenCalledWith('notch:mode-changed', 'expanded')
  })

  it('skips destroyed targets', () => {
    const gone = target(true)
    emitEvent([gone], 'notch:mode-changed', 'compact', createMemoryLogger())
    expect(gone.send).not.toHaveBeenCalled()
  })

  it('refuses payloads outside the contract and logs it', () => {
    const live = target()
    const logger = createMemoryLogger()
    emitEvent([live], 'notch:mode-changed', 'exploded' as 'compact', logger)
    expect(live.send).not.toHaveBeenCalled()
    expect(logger.entries.some((e) => e.level === 'error')).toBe(true)
  })
})
