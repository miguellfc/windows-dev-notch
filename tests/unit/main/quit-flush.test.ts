import { describe, expect, it, vi } from 'vitest'
import { createQuitFlush, type QuitFlushOptions } from '../../../src/main/services/quit-flush'

/**
 * Mimics Electron's Browser::Quit / NotifyAndShutdown: `quit()` is ignored while a quit is in
 * progress, and a prevented `will-quit` only clears that flag after the native dispatch returns,
 * which is after the microtasks queued by the handler have run (modelled with a macrotask).
 */
const fakeApp = (onWillQuit: (event: { preventDefault(): void }) => void) => {
  let quitting = false
  let exited = false
  const quit = (): void => {
    if (quitting || exited) return
    quitting = true
    let prevented = false
    onWillQuit({ preventDefault: () => (prevented = true) })
    if (prevented) setTimeout(() => (quitting = false), 0)
    else exited = true
  }
  return { quit, exited: () => exited }
}

/** Wires a quit flush to a fake app whose `quit()` it calls back. */
const wire = (options: Omit<QuitFlushOptions, 'quit'>) => {
  const app = fakeApp((event) => onWillQuit(event))
  const onWillQuit = createQuitFlush({ ...options, quit: () => app.quit() })
  return app
}

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

describe('quit flush', () => {
  it('quits after a flush that settles immediately (nothing pending to save)', async () => {
    const cleanup = vi.fn()
    const app = wire({ flush: () => Promise.resolve(), timeoutMs: 2_000, cleanup })

    app.quit()
    await settle()

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(app.exited()).toBe(true)
  })

  it('quits after a flush that takes a while', async () => {
    const cleanup = vi.fn()
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5))
    const app = wire({ flush, timeoutMs: 2_000, cleanup })

    app.quit()
    expect(cleanup).not.toHaveBeenCalled()
    await settle()

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(app.exited()).toBe(true)
  })

  it('quits after the timeout when the flush never settles', async () => {
    const cleanup = vi.fn()
    const app = wire({ flush: () => new Promise<void>(() => undefined), timeoutMs: 10, cleanup })

    app.quit()
    await settle(40)

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(app.exited()).toBe(true)
  })

  it('still quits when the flush throws synchronously', async () => {
    const cleanup = vi.fn()
    const flush = (): Promise<void> => {
      throw new Error('disk on fire')
    }
    const app = wire({ flush, timeoutMs: 2_000, cleanup })

    app.quit()
    await settle()

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(app.exited()).toBe(true)
  })

  it('still quits when the flush rejects', async () => {
    const cleanup = vi.fn()
    const app = wire({ flush: () => Promise.reject(new Error('EACCES')), timeoutMs: 2_000, cleanup })

    app.quit()
    await settle()

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(app.exited()).toBe(true)
  })

  it('exits with a single cleanup when quit() is called again while the flush is pending', async () => {
    const cleanup = vi.fn()
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 30))
    const app = wire({ flush, timeoutMs: 2_000, cleanup })

    app.quit()
    await settle(5)
    expect(cleanup).not.toHaveBeenCalled()
    app.quit()
    await settle(80)

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(app.exited()).toBe(true)
  })

  it('runs onFlushStart once, before the flush', () => {
    const order: string[] = []
    const onWillQuit = createQuitFlush({
      flush: () => {
        order.push('flush')
        return Promise.resolve()
      },
      timeoutMs: 2_000,
      quit: () => undefined,
      cleanup: () => order.push('cleanup'),
      onFlushStart: () => order.push('start'),
    })
    onWillQuit({ preventDefault: () => undefined })
    expect(order).toEqual(['start', 'flush'])
  })
})
