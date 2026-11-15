import type { Logger } from '../services/logger'
import type { ForegroundVerdict } from './foreground-classifier'

export interface ForegroundWatcherOptions {
  /** Reads the foreground window and classifies it. Throws on Win32 failures. */
  probe: () => ForegroundVerdict | 'keep'
  onChange: (verdict: ForegroundVerdict) => void
  logger: Logger
  intervalMs?: number
}

export interface ForegroundWatcher {
  start(): void
  stop(): void
  current(): ForegroundVerdict
  /** Probes now and reports the verdict even if unchanged (e.g. the capsule moved monitor). */
  refresh(): void
}

/** Polls the foreground window and reports only changes of verdict (~0.5 ms per poll, M0). */
export function createForegroundWatcher(options: ForegroundWatcherOptions): ForegroundWatcher {
  const { probe, onChange, intervalMs = 500 } = options
  const log = options.logger.child('foreground')
  let current: ForegroundVerdict = 'none'
  let timer: ReturnType<typeof setInterval> | undefined
  let failing = false

  const tick = (force = false) => {
    let verdict: ForegroundVerdict | 'keep'
    try {
      verdict = probe()
      failing = false
    } catch (error) {
      if (!failing) log.error('Foreground probe failed', { error })
      failing = true
      return
    }
    if (verdict === 'keep' || (verdict === current && !force)) return
    current = verdict
    onChange(verdict)
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => tick(), intervalMs)
    },
    refresh: () => tick(true),
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    },
    current: () => current,
  }
}
