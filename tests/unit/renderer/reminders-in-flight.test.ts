import { describe, expect, it, vi } from 'vitest'
import { createInFlightGuard } from '../../../src/renderer/shared/reminders/in-flight'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createInFlightGuard', () => {
  it('runs one call per id at a time: a double click calls the service once', async () => {
    const onChange = vi.fn()
    const guard = createInFlightGuard(onChange)
    const gate = deferred<string>()
    const call = vi.fn(() => gate.promise)

    const first = guard.run('a', call)
    expect(guard.has('a')).toBe(true)
    await expect(guard.run('a', call)).resolves.toBeUndefined()
    expect(call).toHaveBeenCalledTimes(1)

    gate.resolve('done')
    await expect(first).resolves.toBe('done')
    expect(guard.has('a')).toBe(false)
    expect(onChange).toHaveBeenCalledTimes(2) // added, released
  })

  it('keeps other ids independent', async () => {
    const guard = createInFlightGuard(() => undefined)
    const gate = deferred<number>()
    const pending = guard.run('a', () => gate.promise)
    await expect(guard.run('b', async () => 2)).resolves.toBe(2)
    gate.resolve(1)
    await expect(pending).resolves.toBe(1)
  })

  it('releases the id when the call fails', async () => {
    const guard = createInFlightGuard(() => undefined)
    await expect(guard.run('a', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(guard.has('a')).toBe(false)
    await expect(guard.run('a', async () => 'again')).resolves.toBe('again')
  })
})
