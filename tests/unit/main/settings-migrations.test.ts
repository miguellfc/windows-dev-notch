import { describe, expect, it } from 'vitest'
import { DEFAULT_CODE_REVIEW_SETTINGS, DEFAULT_GMAIL_ALERTS, DEFAULT_SYSTEM_ALERTS } from '../../../src/shared/settings/schema'
import {
  migrateSettings,
  settingsMigrations,
  type Migration,
} from '../../../src/main/services/settings-migrations'

describe('migrateSettings', () => {
  it('returns current-version data unchanged', () => {
    const raw = { version: 6, language: 'es' }
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
    expect(settingsMigrations[3]!(raw)).toEqual({ ...raw, version: 4, gmail: { clientId: '', clientSecret: '' } })
  })

  it('migrates v4 settings to v5 adding the gmail alert defaults and keeping the credentials', () => {
    const raw = { version: 4, language: 'es', gmail: { clientId: 'id.apps', clientSecret: 'sec' } }
    expect(migrateSettings(raw, 5)).toEqual({
      kind: 'ok',
      value: { ...raw, version: 5, gmail: { clientId: 'id.apps', clientSecret: 'sec', alerts: DEFAULT_GMAIL_ALERTS } },
      migrated: true,
    })
    expect(raw.gmail).toEqual({ clientId: 'id.apps', clientSecret: 'sec' })
  })

  it('gives each v5 migration its own alerts copy', () => {
    const a = settingsMigrations[4]!({ version: 4, gmail: { clientId: '', clientSecret: '' } })
    const alerts = (a['gmail'] as Record<string, unknown>)['alerts']
    expect(alerts).toEqual(DEFAULT_GMAIL_ALERTS)
    expect(alerts).not.toBe(DEFAULT_GMAIL_ALERTS)
  })

  it('migrates v5 settings to v6 adding the code review defaults and keeping everything else', () => {
    const raw = {
      version: 5,
      language: 'es',
      shortcut: 'Alt+N',
      launchAtLogin: true,
      reminders: { snoozeMinutes: 15, sound: false },
      systemAlerts: { ...DEFAULT_SYSTEM_ALERTS, ram: { enabled: false, percent: 80 } },
      gmail: { clientId: 'id.apps', clientSecret: 'sec', alerts: { enabled: false, hideContent: true, sound: false } },
    }
    const before = structuredClone(raw)
    expect(migrateSettings(raw)).toEqual({
      kind: 'ok',
      value: { ...before, version: 6, codeReview: DEFAULT_CODE_REVIEW_SETTINGS },
      migrated: true,
    })
    expect(raw).toEqual(before)
  })

  it('gives each v6 migration its own code review copy', () => {
    const a = settingsMigrations[5]!({ version: 5 })
    const b = settingsMigrations[5]!({ version: 5 })
    const alertsA = (a['codeReview'] as { alerts: { github: unknown } }).alerts
    const alertsB = (b['codeReview'] as { alerts: { github: unknown } }).alerts
    expect(alertsA).toEqual(DEFAULT_CODE_REVIEW_SETTINGS.alerts)
    expect(alertsA).not.toBe(DEFAULT_CODE_REVIEW_SETTINGS.alerts)
    expect(alertsA.github).not.toBe(alertsB.github)
  })

  it('chains v1 through v6', () => {
    const result = migrateSettings({ version: 1, language: 'en' })
    expect(result).toMatchObject({
      kind: 'ok',
      migrated: true,
      value: {
        version: 6,
        systemAlerts: DEFAULT_SYSTEM_ALERTS,
        gmail: { clientId: '', clientSecret: '', alerts: DEFAULT_GMAIL_ALERTS },
        codeReview: DEFAULT_CODE_REVIEW_SETTINGS,
      },
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
    expect(migrateSettings({ version: 7 }, 1)).toEqual({ kind: 'too-new', version: 7 })
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
