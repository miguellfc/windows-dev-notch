import type { FullSample, LightSample } from '../../shared/system/schema'
import type { SystemApi } from './win32-system'

export interface MetricsSampler {
  light(): LightSample
  full(): FullSample
  /** Forgets the CPU baseline: the next sample reports `cpuPercent: null`. */
  reset(): void
}

interface CpuTimes {
  idleMs: number
  kernelMs: number
  userMs: number
}

/** Rounded 0-100; null for NaN or ±Infinity (a PDH or division glitch), which the schema would reject. */
const clampPercent = (value: number): number | null =>
  Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : null

/** A non-negative byte count or rate; null when not finite. */
const toBytes = (value: number): number | null => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : null)

/** Runs a raw read; a throwing API degrades that metric to null instead of failing the sample. */
function attempt<T>(read: () => T | null): T | null {
  try {
    return read()
  } catch {
    return null
  }
}

/** Pure sampler: turns raw `SystemApi` readings into the samples sent to the renderer. */
export function createMetricsSampler(api: SystemApi): MetricsSampler {
  let previous: CpuTimes | null = null
  let lastCpu: number | null = null

  const cpuPercent = (): number | null => {
    const now = attempt(() => api.systemTimes())
    // A failed or garbled read keeps the previous baseline, so the next good read is still a delta.
    if (!now || !Number.isFinite(now.idleMs + now.kernelMs + now.userMs)) return null
    const before = previous
    previous = now
    if (!before) return null
    // GetSystemTimes: kernel time already includes idle time.
    const total = now.kernelMs - before.kernelMs + (now.userMs - before.userMs)
    if (!(total > 0)) return lastCpu
    const idle = now.idleMs - before.idleMs
    lastCpu = clampPercent((100 * (total - idle)) / total)
    return lastCpu
  }

  const ram = (): LightSample['ram'] => {
    const memory = attempt(() => api.memory())
    if (!memory) return null
    const totalBytes = toBytes(memory.totalBytes)
    const usedBytes = toBytes(memory.totalBytes - memory.availBytes)
    return totalBytes === null || usedBytes === null ? null : { usedBytes, totalBytes }
  }

  const battery = (): LightSample['battery'] => {
    const power = attempt(() => api.power())
    if (!power || !power.hasBattery || power.percent === null) return null
    const percent = clampPercent(power.percent)
    if (percent === null) return null
    const secondsLeft = power.secondsLeft !== null && Number.isInteger(power.secondsLeft) && power.secondsLeft >= 0 ? power.secondsLeft : null
    // Charging implies plugged in; on AC at 100 % the battery is plugged in but not charging.
    return { percent, charging: power.charging, pluggedIn: power.acOnline || power.charging, secondsLeft }
  }

  const light = (): LightSample => ({ cpuPercent: cpuPercent(), ram: ram(), battery: battery() })

  const disks = (): FullSample['disks'] => {
    const idle = attempt(() => api.diskIdlePercent())
    const activityPercent = idle === null ? null : clampPercent(100 - idle)
    const letters = attempt(() => api.fixedDrives()) ?? []
    const result: FullSample['disks'] = []
    for (const letter of letters) {
      const space = attempt(() => api.diskSpace(letter))
      if (!space || !Number.isFinite(space.totalBytes)) continue
      const freeBytes = toBytes(space.freeBytes)
      const usedPercent = space.totalBytes > 0 ? clampPercent((100 * (space.totalBytes - space.freeBytes)) / space.totalBytes) : 0
      if (freeBytes === null || usedPercent === null) continue
      result.push({ letter, usedPercent, freeBytes, activityPercent })
    }
    return result
  }

  const network = (): FullSample['network'] => {
    const rates = attempt(() => api.networkBytesPerSec())
    if (!rates) return null
    const upBytesPerSec = toBytes(rates.up)
    const downBytesPerSec = toBytes(rates.down)
    return upBytesPerSec === null || downBytesPerSec === null ? null : { upBytesPerSec, downBytesPerSec }
  }

  return {
    light,
    full: (): FullSample => ({ ...light(), disks: disks(), network: network() }),
    reset: () => {
      previous = null
      lastCpu = null
    },
  }
}
