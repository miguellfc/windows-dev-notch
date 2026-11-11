import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSystemMonitor, LONG_PAUSE_MS, WARMUP_MS, type MonitorTimers } from '../../../src/main/system/system-monitor'
import type { NotchMode } from '../../../src/shared/notch/state'
import type { ProcessRow } from '../../../src/shared/system/schema'
import { createMemoryLogger } from '../helpers/memory-logger'

const light = { cpuPercent: 10, ram: { usedBytes: 1, totalBytes: 2 }, battery: null }
const full = { ...light, disks: [], network: null }
const row = (pid: number): ProcessRow => ({ pid, name: 'x.exe', cpuPercent: 1, privateBytes: 1, startTime: 't', killable: true })

function setup(options: { available?: boolean } = {}) {
  const metrics = { light: vi.fn(() => light), full: vi.fn(() => full), reset: vi.fn() }
  const processes = {
    top: vi.fn((by: 'cpu' | 'ram') => [row(by === 'cpu' ? 1 : 2)]),
    kill: vi.fn(() => 'killed' as const),
    reset: vi.fn(),
    forgetList: vi.fn(),
  }
  const onMetrics = vi.fn()
  const onProcesses = vi.fn()
  const timers: MonitorTimers = {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  const logger = createMemoryLogger()
  const available = options.available ?? true
  const monitor = createSystemMonitor({
    metrics: available ? metrics : null,
    processes: available ? processes : null,
    timers,
    now: () => Date.now(),
    onMetrics,
    onProcesses,
    logger,
  })
  return { monitor, metrics, processes, onMetrics, onProcesses, logger }
}

/** Enters 'system' and lets the first-time warm-up finish: the full rhythm is running. */
function openView(s: ReturnType<typeof setup>): void {
  s.monitor.setMode('system')
  vi.advanceTimersByTime(WARMUP_MS)
}

describe('system monitor rhythms', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each<NotchMode>(['compact', 'peek', 'expanded', 'terminal', 'reminders', 'permission'])(
    '%s samples light at once and then every 3000 ms',
    (mode) => {
      const { monitor, metrics, onMetrics, processes } = setup()
      monitor.setMode(mode)
      expect(metrics.light).toHaveBeenCalledTimes(1)
      expect(onMetrics).toHaveBeenLastCalledWith({ kind: 'light', ...light })
      vi.advanceTimersByTime(2999)
      expect(metrics.light).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1)
      expect(metrics.light).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(6000)
      expect(metrics.light).toHaveBeenCalledTimes(4)
      expect(metrics.full).not.toHaveBeenCalled()
      expect(processes.top).not.toHaveBeenCalled()
    },
  )

  it('does not restart the rhythm when the mode changes within the light rhythm', () => {
    const { monitor, metrics } = setup()
    monitor.setMode('compact')
    vi.advanceTimersByTime(2000)
    monitor.setMode('expanded')
    expect(metrics.light).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(metrics.light).toHaveBeenCalledTimes(2)
  })

  it('entering system mode the first time warms up silently, then emits full + processes', () => {
    const { monitor, metrics, processes, onMetrics, onProcesses } = setup()
    monitor.setMode('compact')
    onMetrics.mockClear()
    metrics.light.mockClear()
    monitor.setMode('system')
    // Baselines taken (CPU, PDH, per-process CPU) but nothing sent yet.
    expect(metrics.full).toHaveBeenCalledTimes(1)
    expect(processes.top).toHaveBeenCalledTimes(1)
    expect(processes.forgetList).toHaveBeenCalled()
    expect(onMetrics).not.toHaveBeenCalled()
    expect(onProcesses).not.toHaveBeenCalled()
    vi.advanceTimersByTime(WARMUP_MS - 1)
    expect(onMetrics).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onMetrics).toHaveBeenLastCalledWith({ kind: 'full', ...full })
    expect(onProcesses).toHaveBeenLastCalledWith([row(1)])
    expect(metrics.full).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(3000)
    expect(metrics.full).toHaveBeenCalledTimes(5)
    expect(processes.top).toHaveBeenCalledTimes(5)
    expect(metrics.light).not.toHaveBeenCalled()
  })

  it('a quick reopen keeps per-process CPU and emits at once (only the last list is forgotten)', () => {
    const s = setup()
    openView(s)
    s.monitor.setMode('expanded')
    vi.advanceTimersByTime(LONG_PAUSE_MS - 1000)
    s.processes.reset.mockClear()
    s.processes.forgetList.mockClear()
    s.onProcesses.mockClear()
    s.monitor.setMode('system')
    expect(s.processes.reset).not.toHaveBeenCalled()
    expect(s.processes.forgetList).toHaveBeenCalledTimes(1)
    expect(s.onProcesses).toHaveBeenCalledTimes(1)
    expect(s.onMetrics).toHaveBeenLastCalledWith({ kind: 'full', ...full })
  })

  it('a reopen after a long close resets per-process CPU and warms up again', () => {
    const s = setup()
    openView(s)
    s.monitor.setMode('expanded')
    vi.advanceTimersByTime(LONG_PAUSE_MS)
    s.processes.reset.mockClear()
    s.onProcesses.mockClear()
    const order: string[] = []
    s.processes.reset.mockImplementation(() => void order.push('reset'))
    s.processes.top.mockImplementation((by) => {
      order.push('top')
      return [row(by === 'cpu' ? 1 : 2)]
    })
    s.monitor.setMode('system')
    expect(order).toEqual(['reset', 'top'])
    expect(s.onProcesses).not.toHaveBeenCalled()
    vi.advanceTimersByTime(WARMUP_MS)
    expect(s.onProcesses).toHaveBeenCalledTimes(1)
  })

  it('leaving system mode during the warm-up cancels it', () => {
    const { monitor, onMetrics, metrics } = setup()
    monitor.setMode('system')
    monitor.setMode('expanded')
    metrics.full.mockClear()
    vi.advanceTimersByTime(WARMUP_MS * 2)
    expect(metrics.full).not.toHaveBeenCalled()
    expect(onMetrics).toHaveBeenLastCalledWith({ kind: 'light', ...light })
  })

  it('leaving system mode drops to the light rhythm', () => {
    const s = setup()
    openView(s)
    s.metrics.full.mockClear()
    s.monitor.setMode('expanded')
    vi.advanceTimersByTime(3000)
    expect(s.metrics.full).not.toHaveBeenCalled()
    expect(s.metrics.light).toHaveBeenCalled()
  })

  it('a new order sorts the next emission (processes at once, metrics untouched)', () => {
    const s = setup()
    openView(s)
    s.metrics.full.mockClear()
    s.monitor.setOrder('ram')
    expect(s.processes.top).toHaveBeenLastCalledWith('ram')
    expect(s.onProcesses).toHaveBeenLastCalledWith([row(2)])
    expect(s.metrics.full).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(s.processes.top).toHaveBeenLastCalledWith('ram')
    expect(s.metrics.full).toHaveBeenCalledTimes(1)
  })

  it('the same order again does not re-emit', () => {
    const s = setup()
    openView(s)
    s.processes.top.mockClear()
    s.monitor.setOrder('cpu')
    expect(s.processes.top).not.toHaveBeenCalled()
  })

  it('an order sent before system mode (or during the warm-up) is used by the first emission', () => {
    const { monitor, processes, onProcesses } = setup()
    monitor.setOrder('ram')
    expect(processes.top).not.toHaveBeenCalled()
    monitor.setMode('system')
    monitor.setOrder('cpu')
    expect(onProcesses).not.toHaveBeenCalled()
    vi.advanceTimersByTime(WARMUP_MS)
    expect(processes.top).toHaveBeenLastCalledWith('cpu')
    expect(onProcesses).toHaveBeenCalledTimes(1)
  })

  it('the order survives leaving and re-entering system mode', () => {
    const s = setup()
    openView(s)
    s.monitor.setOrder('ram')
    s.monitor.setMode('expanded')
    s.monitor.setMode('system')
    expect(s.processes.top).toHaveBeenLastCalledWith('ram')
  })

  it.each<NotchMode>(['mini', 'hidden', 'alert'])('%s pauses every timer and resets the CPU baseline after a long pause', (paused) => {
    const s = setup()
    openView(s)
    s.metrics.reset.mockClear()
    s.metrics.full.mockClear()
    s.metrics.light.mockClear()
    s.monitor.setMode(paused)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(LONG_PAUSE_MS)
    expect(s.metrics.full).not.toHaveBeenCalled()
    expect(s.metrics.light).not.toHaveBeenCalled()
    expect(s.metrics.reset).not.toHaveBeenCalled()

    const order: string[] = []
    s.metrics.reset.mockImplementation(() => void order.push('reset'))
    s.processes.reset.mockImplementation(() => void order.push('processes-reset'))
    s.metrics.full.mockImplementation(() => {
      order.push('full')
      return full
    })
    // Back straight into 'system': fresh CPU baseline, fresh per-process CPU, silent warm-up.
    s.monitor.setMode('system')
    expect(order).toEqual(['reset', 'processes-reset', 'full'])
    vi.advanceTimersByTime(WARMUP_MS)
    expect(order).toEqual(['reset', 'processes-reset', 'full', 'full'])
  })

  it('a short pause keeps the CPU baseline (no reset) and resumes light at once', () => {
    const { monitor, metrics, processes } = setup()
    monitor.setMode('compact')
    metrics.reset.mockClear()
    monitor.setMode('alert')
    vi.advanceTimersByTime(9_999)
    metrics.light.mockClear()
    monitor.setMode('compact')
    expect(metrics.reset).not.toHaveBeenCalled()
    expect(processes.reset).not.toHaveBeenCalled()
    expect(metrics.light).toHaveBeenCalledTimes(1)
  })

  it('a pause of 10 s or more resets the CPU baseline before the first tick', () => {
    const { monitor, metrics } = setup()
    monitor.setMode('compact')
    metrics.reset.mockClear()
    monitor.setMode('mini')
    vi.advanceTimersByTime(10_000)
    const order: string[] = []
    metrics.reset.mockImplementation(() => void order.push('reset'))
    metrics.light.mockImplementation(() => {
      order.push('light')
      return light
    })
    monitor.setMode('compact')
    expect(order).toEqual(['reset', 'light'])
  })

  it('resync samples at once when running, and stays quiet when paused', () => {
    const { monitor, metrics } = setup()
    monitor.setMode('compact')
    vi.advanceTimersByTime(1000)
    metrics.light.mockClear()
    monitor.resync()
    expect(metrics.light).toHaveBeenCalledTimes(1)
    // The 3 s rhythm restarts from the resync sample.
    vi.advanceTimersByTime(2999)
    expect(metrics.light).toHaveBeenCalledTimes(1)
    monitor.setMode('hidden')
    metrics.light.mockClear()
    monitor.resync()
    expect(metrics.light).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never samples while starting in a paused mode', () => {
    const { monitor, metrics } = setup()
    monitor.setMode('hidden')
    vi.advanceTimersByTime(10_000)
    expect(metrics.light).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('dispose cancels everything, the warm-up included', () => {
    const { monitor, metrics } = setup()
    monitor.setMode('system')
    monitor.dispose()
    expect(vi.getTimerCount()).toBe(0)
    metrics.full.mockClear()
    metrics.light.mockClear()
    monitor.setMode('compact')
    monitor.setOrder('ram')
    vi.advanceTimersByTime(10_000)
    expect(metrics.full).not.toHaveBeenCalled()
    expect(metrics.light).not.toHaveBeenCalled()
  })

  it('a failing sample is logged without details and the rhythm continues', () => {
    const { monitor, metrics, logger } = setup()
    metrics.light.mockImplementationOnce(() => {
      throw new TypeError('boom chrome.exe')
    })
    monitor.setMode('compact')
    vi.advanceTimersByTime(3000)
    expect(metrics.light).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(logger.entries)).not.toContain('chrome')
    expect(logger.entries.some((e) => e.level === 'error')).toBe(true)
  })

  it('a failing warm-up still starts the full rhythm', () => {
    const { monitor, metrics, onMetrics } = setup()
    metrics.full.mockImplementationOnce(() => {
      throw new TypeError('pdh')
    })
    monitor.setMode('system')
    vi.advanceTimersByTime(WARMUP_MS)
    expect(onMetrics).toHaveBeenLastCalledWith({ kind: 'full', ...full })
  })
})

describe('system monitor kill', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('forwards to the sampler and refreshes at once after a kill', () => {
    const s = setup()
    openView(s)
    s.metrics.full.mockClear()
    s.processes.top.mockClear()
    expect(s.monitor.kill({ pid: 1234, startTime: 't' })).toBe('killed')
    expect(s.processes.kill).toHaveBeenCalledWith({ pid: 1234, startTime: 't' })
    expect(s.metrics.full).toHaveBeenCalledTimes(1)
    expect(s.processes.top).toHaveBeenCalledTimes(1)
    // The 1 s rhythm restarts from the kill refresh.
    vi.advanceTimersByTime(999)
    expect(s.metrics.full).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(s.metrics.full).toHaveBeenCalledTimes(2)
    const logged = JSON.stringify(s.logger.entries)
    expect(logged).toContain('killed')
    expect(logged).not.toContain('1234')
    expect(logged).not.toContain('x.exe')
  })

  it('does not refresh when the close did not happen', () => {
    const s = setup()
    openView(s)
    s.metrics.full.mockClear()
    s.processes.kill.mockReturnValueOnce('denied' as never)
    expect(s.monitor.kill({ pid: 5, startTime: 't' })).toBe('denied')
    expect(s.metrics.full).not.toHaveBeenCalled()
  })
})

describe('system monitor without SystemApi', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('emits unavailable once and never arms a timer', () => {
    const { monitor, onMetrics, onProcesses } = setup({ available: false })
    for (const mode of ['compact', 'system', 'mini', 'expanded'] as const) monitor.setMode(mode)
    vi.advanceTimersByTime(10_000)
    expect(onMetrics).toHaveBeenCalledTimes(1)
    expect(onMetrics).toHaveBeenCalledWith({ kind: 'unavailable' })
    expect(onProcesses).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('re-emits unavailable when the view sends its order or the notch reloads', () => {
    const { monitor, onMetrics } = setup({ available: false })
    monitor.setOrder('cpu')
    monitor.resync()
    expect(onMetrics).toHaveBeenCalledTimes(3)
    expect(onMetrics).toHaveBeenLastCalledWith({ kind: 'unavailable' })
    expect(monitor.kill({ pid: 1, startTime: 't' })).toBe('not-killable')
  })
})
