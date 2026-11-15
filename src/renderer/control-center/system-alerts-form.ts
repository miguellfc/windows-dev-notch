import type { SystemAlertSettings } from '../../shared/settings/schema'

/** Allowed values of each threshold field; same bounds as `systemAlertSettingsSchema`. */
export const ALERT_RANGES = {
  cpuPercent: { min: 50, max: 100 },
  cpuSeconds: { min: 5, max: 300 },
  ramPercent: { min: 50, max: 99 },
  batteryPercent: { min: 5, max: 50 },
  diskFreePercent: { min: 1, max: 50 },
} as const

export interface Range {
  readonly min: number
  readonly max: number
}

export type FieldParse = { ok: true; value: number } | { ok: false }

/** A whole number (ASCII digits only) inside `range`; anything else is rejected, never clamped. */
export function parseAlertField(raw: string, range: Range): FieldParse {
  const text = raw.trim()
  if (!/^[0-9]+$/.test(text)) return { ok: false }
  const value = Number(text)
  return value >= range.min && value <= range.max ? { ok: true, value } : { ok: false }
}

/** A copy of `alerts` with `change` merged into one alert; the caller sends the whole object. */
export function withAlertChange<K extends keyof SystemAlertSettings>(
  alerts: SystemAlertSettings,
  key: K,
  change: Partial<SystemAlertSettings[K]>,
): SystemAlertSettings {
  return { ...alerts, [key]: { ...alerts[key], ...change } }
}

export interface AlertSaver {
  /** Merges `change` into one alert and sends the whole object; resolves once this save is done (sent or failed). */
  save<K extends keyof SystemAlertSettings>(
    key: K,
    change: Partial<SystemAlertSettings[K]>,
    fallback: SystemAlertSettings,
  ): Promise<void>
}

/**
 * Serializes alert saves so quick edits never overwrite each other. Each save merges its change into a
 * local pending object, updated synchronously, so the next save starts from it even before the store
 * has caught up; sends run one after another, each sending the object as it stood after its own change.
 * When no save is queued the pending object is dropped and the next save starts from the store again
 * (which may hold a change made in another window), or from `fallback` before settings load.
 */
export function createAlertSaver(
  read: () => SystemAlertSettings | undefined,
  send: (alerts: SystemAlertSettings) => Promise<unknown>,
): AlertSaver {
  let pending: SystemAlertSettings | null = null
  let queued = 0
  let chain: Promise<void> = Promise.resolve()

  return {
    save(key, change, fallback) {
      const next = withAlertChange(pending ?? read() ?? fallback, key, change)
      pending = next
      queued += 1
      chain = chain.then(async () => {
        try {
          await send(next)
        } catch {
          // The store keeps its last good value; later saves still run.
        } finally {
          queued -= 1
          if (queued === 0) pending = null
        }
      })
      return chain
    },
  }
}
