import { SETTINGS_VERSION } from '../../shared/settings/schema'

export type Migration = (raw: Record<string, unknown>) => Record<string, unknown>

/** Step from version N (key) to N+1. Empty while only version 1 exists. */
export const settingsMigrations: Readonly<Record<number, Migration>> = {}

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
