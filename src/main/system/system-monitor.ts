import type { NotchMode } from '../../shared/notch/state'
import type { KillInput, KillResult, ProcessOrder, ProcessRow, SystemMetrics } from '../../shared/system/schema'
import type { Logger } from '../services/logger'
import type { MetricsSampler } from './metrics-sampler'
import type { ProcessSampler } from './process-sampler'

export const LIGHT_INTERVAL_MS = 3000
export const FULL_INTERVAL_MS = 1000
/** A pause at least this long resets the CPU baseline; over a shorter one the delta is a true average. */
export const LONG_PAUSE_MS = 10_000
/**
 * When the view opens with no recent full sample, main samples once silently and sends the first
 * full sample this much later, so per-process CPU and the PDH rates (which need two reads at least
 * 500 ms apart) are real values instead of "—".
 */
export const WARMUP_MS = 600

/** Modes where nothing is sampled: the capsule is a pill, off screen, or showing an alert. */
const PAUSED_MODES: ReadonlySet<NotchMode> = new Set<NotchMode>(['mini', 'hidden', 'alert'])

export interface MonitorTimers {
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface SystemMonitorOptions {
  /** Both null when the Win32 API could not load: the monitor only reports `unavailable`. */
  metrics: MetricsSampler | null
  processes: ProcessSampler | null
  timers: MonitorTimers
  /** Monotonic clock in ms, used to measure pauses. */
  now: () => number
  onMetrics: (metrics: SystemMetrics) => void
  onProcesses: (rows: ProcessRow[]) => void
  logger: Logger
}

export interface SystemMonitor {
  /** The 'system' mode is the System view: entering it starts the full rhythm, leaving it stops it. */
  setMode(mode: NotchMode): void
  /** The process order for the next emissions (re-sorts at once while the view is open). */
  setOrder(by: ProcessOrder): void
  kill(input: KillInput): KillResult
  /** The notch (re)loaded: samples at once (or re-sends `unavailable`) so it never waits for data. */
  resync(): void
  dispose(): void
}

type Rhythm = 'paused' | 'light' | 'full'

/**
 * Decides when to sample: light every 3 s while the capsule is visible, full + processes every
 * 1 s in 'system' mode (the System view), nothing in mini / hidden / alert. Exactly one of light()
 * or full() runs per tick, because both share the CPU baseline. The view's open state follows the
 * mode alone, so a renderer remount (e.g. a revived exit animation) can never stop the rhythm.
 */
export function createSystemMonitor(options: SystemMonitorOptions): SystemMonitor {
  const { metrics, processes, timers, onMetrics, onProcesses } = options
  const log = options.logger.child('system-monitor')
  const available = metrics !== null && processes !== null

  let mode: NotchMode = 'hidden'
  let order: ProcessOrder = 'cpu'
  let rhythm: Rhythm = 'paused'
  let handle: unknown = null
  /** The one-shot timer of a warm-up; null otherwise. */
  let warmup: unknown = null
  /** When the last full sample (or warm-up) ran; null before the first one. */
  let lastFullAt: number | null = null
  /** When the current pause began; null before the first rhythm (always a fresh start). */
  let pausedAt: number | null = null
  let disposed = false

  const unavailable = () => onMetrics({ kind: 'unavailable' })

  const desired = (): Rhythm => {
    if (PAUSED_MODES.has(mode)) return 'paused'
    return mode === 'system' ? 'full' : 'light'
  }

  /** Never logs the error message: it could carry a process name. */
  const guarded = (what: string, run: () => void) => {
    try {
      run()
    } catch (error) {
      log.error('System sample failed', { what, error: error instanceof Error ? error.name : typeof error })
    }
  }

  const emitProcesses = () => {
    if (!processes) return
    guarded('processes', () => onProcesses(processes.top(order)))
  }

  const tick = () => {
    if (!metrics) return
    if (rhythm === 'full') {
      lastFullAt = options.now()
      guarded('full', () => onMetrics({ kind: 'full', ...metrics.full() }))
      emitProcesses()
    } else if (rhythm === 'light') {
      guarded('light', () => onMetrics({ kind: 'light', ...metrics.light() }))
    }
  }

  const stopTimer = () => {
    if (handle !== null) timers.clearInterval(handle)
    if (warmup !== null) timers.clearTimeout(warmup)
    handle = null
    warmup = null
  }

  /** Samples now and restarts the interval from this sample. */
  const restart = () => {
    stopTimer()
    if (rhythm === 'paused') return
    tick()
    handle = timers.setInterval(tick, rhythm === 'full' ? FULL_INTERVAL_MS : LIGHT_INTERVAL_MS)
  }

  /** Takes silent baselines now and starts the full rhythm WARMUP_MS later. */
  const warmUp = () => {
    stopTimer()
    if (!metrics || !processes) return
    lastFullAt = options.now()
    guarded('warm-up', () => {
      metrics.full()
      processes.top(order)
    })
    // The warm-up list never reached the view: nothing in it may be closed.
    processes.forgetList()
    warmup = timers.setTimeout(() => {
      warmup = null
      restart()
    }, WARMUP_MS)
  }

  const apply = () => {
    if (disposed || !available) return
    const next = desired()
    if (next === rhythm) return
    const previous = rhythm
    rhythm = next
    if (next === 'paused') {
      stopTimer()
      pausedAt = options.now()
      return
    }
    // After a long pause the old CPU baseline is stale: forget it (the next CPU is null). A short
    // pause (e.g. a brief alert) keeps it, so the capsule does not flash "—".
    if (previous === 'paused' && (pausedAt === null || options.now() - pausedAt >= LONG_PAUSE_MS)) metrics.reset()
    if (next === 'full') {
      // A fresh view may only close rows it shows. Per-process CPU baselines survive a short
      // close (the delta is then a true average); after a long one they are stale.
      processes.forgetList()
      if (lastFullAt === null || options.now() - lastFullAt >= LONG_PAUSE_MS) {
        processes.reset()
        warmUp()
        return
      }
    }
    restart()
  }

  if (!available) unavailable()

  return {
    setMode(next) {
      mode = next
      apply()
    },
    setOrder(by) {
      if (disposed) return
      // The view sends its order on mount: an unavailable monitor answers with its state again.
      if (!available) {
        unavailable()
        return
      }
      if (by === order) return
      order = by
      // A new order re-sorts at once (the sampler reuses CPU values on a short interval); during a
      // warm-up the first emission already uses it.
      if (rhythm === 'full' && warmup === null) emitProcesses()
    },
    kill(input) {
      if (disposed || !processes) return 'not-killable'
      const result = processes.kill(input)
      log.info('Process close requested', { result })
      if (result === 'killed' && rhythm === 'full') restart()
      return result
    },
    resync() {
      if (disposed) return
      if (!available) unavailable()
      else if (rhythm !== 'paused') restart()
    },
    dispose() {
      disposed = true
      stopTimer()
      rhythm = 'paused'
    },
  }
}
