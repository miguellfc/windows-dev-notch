import { describe, expect, it, vi } from 'vitest'
import { createTestClockTimers } from '../../../src/main/services/test-clock-timers'

const setup = () => {
  let clock = 1_000
  const real = { setTimeout: vi.fn<(callback: () => void, ms: number) => unknown>(() => Symbol('real')), clearTimeout: vi.fn() }
  const timers = createTestClockTimers(() => clock, real)
  return { timers, real, move: (ms: number) => (clock += ms) }
}

describe('createTestClockTimers', () => {
  it('arms a real timer too, so it still fires in real time', () => {
    const { timers, real } = setup()
    const callback = vi.fn()
    timers.setTimeout(callback, 60_000)
    expect(real.setTimeout).toHaveBeenCalledWith(expect.any(Function), 60_000)
    const fire = real.setTimeout.mock.calls[0]?.[0]
    fire?.()
    expect(callback).toHaveBeenCalledTimes(1)
    // Fired already: moving the clock does not run it again.
    timers.fireDue()
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('fires only the timers the moved clock has reached, once, and clears their real timer', () => {
    const { timers, real, move } = setup()
    const soon = vi.fn()
    const later = vi.fn()
    timers.setTimeout(soon, 60_000)
    timers.setTimeout(later, 120_000)
    move(59_999)
    timers.fireDue()
    expect(soon).not.toHaveBeenCalled()
    move(1)
    timers.fireDue()
    expect(soon).toHaveBeenCalledTimes(1)
    expect(later).not.toHaveBeenCalled()
    expect(real.clearTimeout).toHaveBeenCalledTimes(1)
    timers.fireDue()
    expect(soon).toHaveBeenCalledTimes(1)
  })

  it('never fires a cleared timer', () => {
    const { timers, real, move } = setup()
    const callback = vi.fn()
    const handle = timers.setTimeout(callback, 10)
    timers.clearTimeout(handle)
    expect(real.clearTimeout).toHaveBeenCalledTimes(1)
    move(10)
    timers.fireDue()
    expect(callback).not.toHaveBeenCalled()
    // An unknown handle is ignored.
    timers.clearTimeout({})
    expect(real.clearTimeout).toHaveBeenCalledTimes(1)
  })

  it('leaves a timer armed by a fired callback for a later move', () => {
    const { timers, move } = setup()
    const next = vi.fn()
    timers.setTimeout(() => timers.setTimeout(next, 60_000), 60_000)
    move(60_000)
    timers.fireDue()
    expect(next).not.toHaveBeenCalled()
    move(60_000)
    timers.fireDue()
    expect(next).toHaveBeenCalledTimes(1)
  })
})
