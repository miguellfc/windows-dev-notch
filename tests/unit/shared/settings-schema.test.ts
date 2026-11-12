import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GMAIL_SETTINGS,
  DEFAULT_SYSTEM_ALERTS,
  SETTINGS_VERSION,
  createDefaultSettings,
  languageFromLocale,
  settingsPatchSchema,
  settingsSchema,
} from '../../../src/shared/settings/schema'

describe('languageFromLocale', () => {
  it('maps Spanish locales to es', () => {
    expect(languageFromLocale('es-ES')).toBe('es')
    expect(languageFromLocale('ES-mx')).toBe('es')
  })

  it('falls back to en for any other locale', () => {
    expect(languageFromLocale('en-US')).toBe('en')
    expect(languageFromLocale('fr-FR')).toBe('en')
    expect(languageFromLocale('')).toBe('en')
  })
})

describe('createDefaultSettings', () => {
  it('produces valid settings for the current version', () => {
    const defaults = createDefaultSettings('es-ES')
    expect(settingsSchema.parse(defaults)).toEqual(defaults)
    expect(defaults.version).toBe(SETTINGS_VERSION)
    expect(defaults.language).toBe('es')
    expect(defaults.shortcut).toBe('Control+Alt+Space')
    expect(defaults.launchAtLogin).toBe(false)
    expect(defaults.reminders).toEqual({ snoozeMinutes: 10, sound: true })
    expect(defaults.systemAlerts).toEqual(DEFAULT_SYSTEM_ALERTS)
  })
})

describe('settingsSchema', () => {
  const valid = createDefaultSettings('en-US')

  it('rejects unknown keys', () => {
    expect(settingsSchema.safeParse({ ...valid, extra: true }).success).toBe(false)
  })

  it('rejects unsupported languages', () => {
    expect(settingsSchema.safeParse({ ...valid, language: 'fr' }).success).toBe(false)
  })

  it('rejects malformed shortcuts', () => {
    for (const shortcut of ['', 'Control+', '+Space', 'Ctrl Alt', 'a'.repeat(65), 'Control+Alt+Space;rm']) {
      expect(settingsSchema.safeParse({ ...valid, shortcut }).success, shortcut).toBe(false)
    }
  })

  it('accepts well-formed shortcuts', () => {
    for (const shortcut of ['Control+Alt+Space', 'Alt+N', 'Control+F12', 'Super+Shift+1']) {
      expect(settingsSchema.safeParse({ ...valid, shortcut }).success, shortcut).toBe(true)
    }
  })

  it('only allows the supported snooze durations', () => {
    for (const snoozeMinutes of [5, 10, 15, 30]) {
      expect(settingsSchema.safeParse({ ...valid, reminders: { snoozeMinutes, sound: true } }).success).toBe(true)
    }
    expect(settingsSchema.safeParse({ ...valid, reminders: { snoozeMinutes: 7, sound: true } }).success).toBe(false)
  })

  it('rejects shortcuts that would steal a plain key from every app', () => {
    for (const shortcut of ['A', 'F12', 'Space', 'Shift+A', 'Control+Alt', 'Alt+Shift']) {
      expect(settingsSchema.safeParse({ ...valid, shortcut }).success, shortcut).toBe(false)
    }
  })
})

describe('system alert settings', () => {
  const valid = createDefaultSettings('en-US')
  const withAlerts = (systemAlerts: unknown) => settingsSchema.safeParse({ ...valid, systemAlerts }).success
  const patch = (path: ['cpu' | 'ram' | 'battery' | 'disk', string], value: number) => ({
    ...DEFAULT_SYSTEM_ALERTS,
    [path[0]]: { ...DEFAULT_SYSTEM_ALERTS[path[0]], [path[1]]: value },
  })

  it('has the documented defaults, all enabled', () => {
    expect(DEFAULT_SYSTEM_ALERTS).toEqual({
      cpu: { enabled: true, percent: 90, sustainSeconds: 30 },
      ram: { enabled: true, percent: 90 },
      battery: { enabled: true, percent: 15 },
      disk: { enabled: true, freePercent: 10 },
    })
    expect(withAlerts(DEFAULT_SYSTEM_ALERTS)).toBe(true)
  })

  it('enforces the ranges at and beyond their edges', () => {
    const cases: [['cpu' | 'ram' | 'battery' | 'disk', string], number, number, number, number][] = [
      [['cpu', 'percent'], 50, 100, 49, 101],
      [['cpu', 'sustainSeconds'], 5, 300, 4, 301],
      [['ram', 'percent'], 50, 99, 49, 100],
      [['battery', 'percent'], 5, 50, 4, 51],
      [['disk', 'freePercent'], 1, 50, 0, 51],
    ]
    for (const [path, lo, hi, below, above] of cases) {
      expect(withAlerts(patch(path, lo)), `${path} ${lo}`).toBe(true)
      expect(withAlerts(patch(path, hi)), `${path} ${hi}`).toBe(true)
      expect(withAlerts(patch(path, below)), `${path} ${below}`).toBe(false)
      expect(withAlerts(patch(path, above)), `${path} ${above}`).toBe(false)
    }
  })

  it('rejects non-integers, missing sections and unknown keys', () => {
    expect(withAlerts(patch(['cpu', 'percent'], 90.5))).toBe(false)
    expect(withAlerts({ ...DEFAULT_SYSTEM_ALERTS, disk: undefined })).toBe(false)
    expect(withAlerts({ ...DEFAULT_SYSTEM_ALERTS, extra: 1 })).toBe(false)
    expect(withAlerts({ ...DEFAULT_SYSTEM_ALERTS, ram: { ...DEFAULT_SYSTEM_ALERTS.ram, extra: 1 } })).toBe(false)
  })

  it('accepts a full systemAlerts patch', () => {
    const next = { ...DEFAULT_SYSTEM_ALERTS, cpu: { enabled: false, percent: 80, sustainSeconds: 60 } }
    expect(settingsPatchSchema.parse({ systemAlerts: next })).toEqual({ systemAlerts: next })
    expect(settingsPatchSchema.safeParse({ systemAlerts: { cpu: next.cpu } }).success).toBe(false)
  })
})

describe('settingsPatchSchema', () => {
  it('accepts a partial patch', () => {
    expect(settingsPatchSchema.parse({ language: 'en' })).toEqual({ language: 'en' })
  })

  it('accepts a reminders patch', () => {
    const patch = { reminders: { snoozeMinutes: 15, sound: false } }
    expect(settingsPatchSchema.parse(patch)).toEqual(patch)
    expect(settingsPatchSchema.safeParse({ reminders: { snoozeMinutes: 7, sound: false } }).success).toBe(false)
  })

  it('rejects an empty patch', () => {
    expect(settingsPatchSchema.safeParse({}).success).toBe(false)
  })

  it('rejects a patch whose values are all undefined', () => {
    expect(settingsPatchSchema.safeParse({ language: undefined }).success).toBe(false)
  })

  it('does not allow changing the version', () => {
    expect(settingsPatchSchema.safeParse({ version: SETTINGS_VERSION }).success).toBe(false)
  })

  it('rejects non-object input', () => {
    expect(settingsPatchSchema.safeParse('en').success).toBe(false)
    expect(settingsPatchSchema.safeParse(undefined).success).toBe(false)
  })
})

describe('gmail settings', () => {
  it('is at version 4 with empty credentials by default', () => {
    expect(SETTINGS_VERSION).toBe(4)
    expect(createDefaultSettings('en-US').gmail).toEqual({ clientId: '', clientSecret: '' })
    expect(DEFAULT_GMAIL_SETTINGS).toEqual({ clientId: '', clientSecret: '' })
  })

  it('accepts a gmail patch and rejects extra keys or non-strings', () => {
    const patch = { gmail: { clientId: 'id', clientSecret: 'sec' } }
    expect(settingsPatchSchema.parse(patch)).toEqual(patch)
    expect(settingsPatchSchema.safeParse({ gmail: { clientId: 'id' } }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ gmail: { clientId: 1, clientSecret: '' } }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ gmail: { clientId: '', clientSecret: '', x: 1 } }).success).toBe(false)
  })
})
