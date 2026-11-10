import { describe, expect, it } from 'vitest'
import {
  migrateSettings,
  settingsMigrations,
  type Migration,
} from '../../../src/main/services/settings-migrations'

describe('migrateSettings', () => {
  it('returns current-version data unchanged', () => {
    const raw = { version: 2, language: 'es' }
    expect(migrateSettings(raw)).toEqual({ kind: 'ok', value: raw, migrated: false })
  })

  it('migrates v1 settings to v2 adding reminder defaults', () => {
    const raw = { version: 1, language: 'es', shortcut: 'Alt+N', launchAtLogin: false }
    expect(migrateSettings(raw)).toEqual({
      kind: 'ok',
      value: { ...raw, version: 2, reminders: { snoozeMinutes: 10, sound: true } },
      migrated: true,
    })
    expect(settingsMigrations[1]).toBeTypeOf('function')
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
