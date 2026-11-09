import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createForegroundWatcher } from '../../../src/main/platform/foreground-watcher'
import type { ForegroundVerdict } from '../../../src/main/platform/foreground-classifier'
import { createMemoryLogger } from '../helpers/memory-logger'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function setup(verdicts: (ForegroundVerdict | 'keep' | Error)[]) {
  const logger = createMemoryLogger()
  const onChange = vi.fn()
  let index = 0
  const watcher = createForegroundWatcher({
    intervalMs: 500,
    probe: () => {
      const next = verdicts[Math.min(index, verdicts.length - 1)] ?? 'keep'
      index += 1
      if (next instanceof Error) throw next
      return next
    },
    onChange,
    logger,
  })
  return { watcher, onChange, logger }
}

describe('createForegroundWatcher', () => {
  it('reports only changes of verdict', () => {
    const { watcher, onChange } = setup(['none', 'none', 'mini', 'mini', 'hidden', 'none'])
    watcher.start()
    vi.advanceTimersByTime(500 * 6)
    expect(onChange.mock.calls.map(([v]) => v)).toEqual(['mini', 'hidden', 'none'])
    expect(watcher.current()).toBe('none')
  })

  it('keeps the previous verdict when told to', () => {
    const { watcher, onChange } = setup(['mini', 'keep', 'keep', 'none'])
    watcher.start()
    vi.advanceTimersByTime(500 * 4)
    expect(onChange.mock.calls.map(([v]) => v)).toEqual(['mini', 'none'])
  })

  it('survives probe errors and logs them once', () => {
    const { watcher, onChange, logger } = setup([new Error('boom'), new Error('boom'), 'mini'])
    watcher.start()
    vi.advanceTimersByTime(500 * 3)
    expect(onChange).toHaveBeenCalledWith('mini')
    expect(logger.entries.filter((e) => e.level === 'error')).toHaveLength(1)
  })

  it('re-reports the verdict on refresh, e.g. after moving to another monitor', () => {
    const { watcher, onChange } = setup(['mini', 'mini'])
    watcher.start()
    vi.advanceTimersByTime(500)
    watcher.refresh()
    expect(onChange.mock.calls.map(([v]) => v)).toEqual(['mini', 'mini'])
  })

  it('stops polling when stopped', () => {
    const { watcher, onChange } = setup(['mini'])
    watcher.start()
    watcher.stop()
    vi.advanceTimersByTime(5000)
    expect(onChange).not.toHaveBeenCalled()
  })
})
