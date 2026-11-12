import { describe, expect, it } from 'vitest'
import { DEFAULT_SYSTEM_ALERTS } from '../../../src/shared/settings/schema'
import {
  migrateSettings,
  settingsMigrations,
  type Migration,
} from '../../../src/main/services/settings-migrations'

describe('migrateSettings', () => {
  it('returns current-version data unchanged', () => {
    const raw = { version: 4, language: 'es' }
    expect(migrateSettings(raw)).toEqual({ kind: 'ok', value: raw, migrated: false })
  })

  it('migrates v1 settings to v2 adding reminder defaults', () => {
    const raw = { version: 1, language: 'es', shortcut: 'Alt+N', launchAtLogin: false }
    expect(settingsMigrations[1]!(raw)).toEqual({ ...raw, version: 2, reminders: { snoozeMinutes: 10, sound: true } })
  })

  it('migrates v2 settings to v3 adding the system alert defaults', () => {
    const raw = { version: 2, language: 'es', reminders: { snoozeMinutes: 10, sound: true } }
    expect(settingsMigrations[2]!(raw)).toEqual({ ...raw, version: 3, systemAlerts: DEFAULT_SYSTEM_ALERTS })
  })

  it('migrates v3 settings to v4 adding empty gmail credentials', () => {
    const raw = { version: 3, language: 'es' }
    expect(migrateSettings(raw)).toEqual({
      kind: 'ok',
      value: { ...raw, version: 4, gmail: { clientId: '', clientSecret: '' } },
      migrated: true,
    })
  })

  it('chains v1 through v4', () => {
    const result = migrateSettings({ version: 1, language: 'en' })
    expect(result).toMatchObject({
      kind: 'ok',
      migrated: true,
      value: { version: 4, systemAlerts: DEFAULT_SYSTEM_ALERTS, gmail: { clientId: '', clientSecret: '' } },
    })
  })

  it('gives each migrated file its own copy of the defaults', () => {
    const a = migrateSettings({ version: 2 })
    const b = migrateSettings({ version: 2 })
    if (a.kind !== 'ok' || b.kind !== 'ok') throw new Error('expected ok')
    expect(a.value['systemAlerts']).not.toBe(b.value['systemAlerts'])
    expect(a.value['systemAlerts']).not.toBe(DEFAULT_SYSTEM_ALERTS)
  })

  it('applies each step in order up to the target version', () => {
    const steps: Record<number, Migration> = {
      1: (raw) => ({ ...raw, version: 2, a: true }),
      2: (raw) => ({ ...raw, version: 3, b: true }),
    }
    expect(migrateSettings({ version: 1 }, 3, steps)).toEqual({
      kind: 'ok',
      value: { version: 3, a: true, b: true },
      migrated: true,
    })
  })

  it('reports files from a newer version', () => {
    expect(migrateSettings({ version: 5 }, 1)).toEqual({ kind: 'too-new', version: 5 })
  })

  it('rejects non-objects, missing versions and missing steps', () => {
    expect(migrateSettings(null).kind).toBe('invalid')
    expect(migrateSettings([1]).kind).toBe('invalid')
    expect(migrateSettings({ language: 'es' }).kind).toBe('invalid')
    expect(migrateSettings({ version: 1.5 }).kind).toBe('invalid')
    expect(migrateSettings({ version: 1 }, 2, {}).kind).toBe('invalid')
  })

  it('rejects a step that does not advance the version', () => {
    const steps: Record<number, Migration> = { 1: (raw) => ({ ...raw }) }
    expect(migrateSettings({ version: 1 }, 2, steps).kind).toBe('invalid')
  })
})
