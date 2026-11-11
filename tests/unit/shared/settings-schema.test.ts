import { describe, expect, it } from 'vitest'
import {
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
    expect(settingsPatchSchema.safeParse({ version: 3 }).success).toBe(false)
  })

  it('rejects non-object input', () => {
    expect(settingsPatchSchema.safeParse('en').success).toBe(false)
    expect(settingsPatchSchema.safeParse(undefined).success).toBe(false)
  })
})
