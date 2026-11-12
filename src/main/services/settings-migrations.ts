import {
  DEFAULT_GMAIL_SETTINGS,
  DEFAULT_REMINDERS_SETTINGS,
  SETTINGS_VERSION,
  cloneDefaultSystemAlerts,
} from '../../shared/settings/schema'

export type Migration = (raw: Record<string, unknown>) => Record<string, unknown>

/** Step from version N (key) to N+1. */
export const settingsMigrations: Readonly<Record<number, Migration>> = {
  // v2 adds the reminders settings (snooze duration and sound).
  1: (raw) => ({ ...raw, version: 2, reminders: { ...DEFAULT_REMINDERS_SETTINGS } }),
  // v3 adds the system alert thresholds (CPU, RAM, battery, disk).
  2: (raw) => ({ ...raw, version: 3, systemAlerts: cloneDefaultSystemAlerts() }),
  // v4 adds the Gmail OAuth client credentials (empty until the user configures them).
  3: (raw) => ({ ...raw, version: 4, gmail: { ...DEFAULT_GMAIL_SETTINGS } }),
}

export type MigrationResult =
  | { kind: 'ok'; value: Record<string, unknown>; migrated: boolean }
  | { kind: 'too-new'; version: number }
  | { kind: 'invalid' }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Brings raw settings up to `target`, one step at a time. Never guesses a missing version. */
export function migrateSettings(
  raw: unknown,
  target: number = SETTINGS_VERSION,
  steps: Readonly<Record<number, Migration>> = settingsMigrations,
): MigrationResult {
  if (!isRecord(raw) || !Number.isInteger(raw['version'])) return { kind: 'invalid' }

  let current = raw
  let version = raw['version'] as number
  if (version > target) return { kind: 'too-new', version }

  while (version < target) {
    const step = steps[version]
    if (!step) return { kind: 'invalid' }
    current = step(current)
    const next = current['version']
    if (typeof next !== 'number' || next <= version) return { kind: 'invalid' }
    version = next
  }

  return { kind: 'ok', value: current, migrated: current !== raw }
}
