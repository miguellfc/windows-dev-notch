import { performance } from 'node:perf_hooks'
import type { NotchMode } from '../../shared/notch/state'
import type { KillInput, KillResult, ProcessOrder } from '../../shared/system/schema'
import { emitEvent, type EventTarget } from '../ipc/events'
import type { SystemAlertSettings } from '../../shared/settings/schema'
import type { Logger } from '../services/logger'
import { createAlertEvaluator } from './alerts'
import { createMetricsSampler } from './metrics-sampler'
import { createProcessSampler } from './process-sampler'
import { createSystemIpcHandlers } from './system-ipc'
import { createSystemMonitor, type SystemMonitor } from './system-monitor'
import { createWin32SystemApi, type SystemApi } from './win32-system'

export interface SystemIntegrationOptions {
  logger: Logger
  /** Current notch mode, read once the monitor starts. */
  mode: () => NotchMode
  /** The live alert settings (read on every sample, so a change applies to the next one). */
  alertSettings: () => SystemAlertSettings
  /** The notch window, when it exists: the only receiver of `system:*` events. */
  notchTarget: () => EventTarget | null
}

/**
 * Electron adapter around the system monitor. Created early (before the notch controller, which
 * reports mode changes here) but the Win32 API only loads in `start()`, after registerIpc.
 */
export function createSystemIntegration(options: SystemIntegrationOptions) {
  const { logger } = options
  let api: SystemApi | null = null
  let monitor: SystemMonitor | null = null
  let disposed = false
  // An order that arrives before start() is replayed once the monitor exists.
  let pendingOrder: ProcessOrder | null = null

  const toNotch = (send: (target: EventTarget) => void) => {
    const target = options.notchTarget()
    if (target) send(target)
  }

  const facade = {
    setOrder: (by: ProcessOrder) => {
      if (monitor) monitor.setOrder(by)
      else pendingOrder = by
    },
    kill: (input: KillInput): KillResult => monitor?.kill(input) ?? 'not-killable',
  }

  return {
    handlers: createSystemIpcHandlers(facade),
    /** Loads the Win32 API off the startup path and starts sampling for the current mode. */
    start: async (): Promise<void> => {
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (disposed) return
      api = createWin32SystemApi(logger)
      if (!api) logger.child('system-monitor').warn('System monitor unavailable')
      monitor = createSystemMonitor({
        metrics: api ? createMetricsSampler(api) : null,
        // Monotonic clock: a wall-clock change must never freeze per-process CPU.
        processes: api ? createProcessSampler(api, () => performance.now()) : null,
        now: () => performance.now(),
        timers: {
          setInterval,
          clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
          setTimeout,
          clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        },
        onMetrics: (metrics) => toNotch((target) => emitEvent([target], 'system:metrics', metrics, logger)),
        onProcesses: (rows) => toNotch((target) => emitEvent([target], 'system:processes', rows, logger)),
        alerts: createAlertEvaluator(),
        alertSettings: options.alertSettings,
        logger,
      })
      if (pendingOrder) monitor.setOrder(pendingOrder)
      pendingOrder = null
      monitor.setMode(options.mode())
    },
    setMode: (mode: NotchMode) => monitor?.setMode(mode),
    /** The notch page (re)loaded. */
    resync: () => monitor?.resync(),
    dispose: () => {
      disposed = true
      monitor?.dispose()
      api?.dispose()
    },
  }
}
