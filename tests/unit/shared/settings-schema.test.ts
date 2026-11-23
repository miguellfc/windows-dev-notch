import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CODE_REVIEW_SETTINGS,
  DEFAULT_GMAIL_ALERTS,
  DEFAULT_GMAIL_SETTINGS,
  DEFAULT_REDMINE_SETTINGS,
  DEFAULT_SYSTEM_ALERTS,
  SETTINGS_VERSION,
  cloneDefaultIntegrations,
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
  it('has empty credentials and the alert defaults', () => {
    expect(DEFAULT_GMAIL_SETTINGS).toEqual({ clientId: '', clientSecret: '' })
    expect(DEFAULT_GMAIL_ALERTS).toEqual({ enabled: true, hideContent: false, sound: true })
    expect(createDefaultSettings('en-US').gmail).toEqual({
      clientId: '',
      clientSecret: '',
      alerts: { enabled: true, hideContent: false, sound: true },
    })
  })

  it('gives each default settings object its own alerts copy', () => {
    const a = createDefaultSettings('en-US')
    expect(a.gmail.alerts).not.toBe(createDefaultSettings('en-US').gmail.alerts)
    expect(a.gmail.alerts).not.toBe(DEFAULT_GMAIL_ALERTS)
  })

  it('accepts a gmail patch and rejects extra keys or non-strings', () => {
    const alerts = { enabled: true, hideContent: false, sound: true }
    const patch = { gmail: { clientId: 'id', clientSecret: 'sec', alerts } }
    expect(settingsPatchSchema.parse(patch)).toEqual(patch)
    expect(settingsPatchSchema.safeParse({ gmail: { clientId: 'id', alerts } }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ gmail: { clientId: 1, clientSecret: '', alerts } }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ gmail: { clientId: '', clientSecret: '', alerts, x: 1 } }).success).toBe(false)
  })

  it('requires strict boolean alert settings', () => {
    const base = { clientId: '', clientSecret: '' }
    expect(settingsPatchSchema.safeParse({ gmail: base }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ gmail: { ...base, alerts: { enabled: true, hideContent: false } } }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ gmail: { ...base, alerts: { enabled: 'yes', hideContent: false, sound: true } } }).success).toBe(false)
    expect(
      settingsPatchSchema.safeParse({ gmail: { ...base, alerts: { enabled: true, hideContent: false, sound: true, x: 1 } } }).success,
    ).toBe(false)
  })
})

describe('code review settings', () => {
  const valid = createDefaultSettings('en-US')
  const alerts = { github: { enabled: true, sound: true }, gitlab: { enabled: true, sound: true } }
  const withCodeReview = (codeReview: unknown) => settingsSchema.safeParse({ ...valid, codeReview }).success

  it('is at version 10 with an empty GitLab URL and every alert on', () => {
    expect(SETTINGS_VERSION).toBe(10)
    expect(DEFAULT_CODE_REVIEW_SETTINGS).toEqual({ gitlabUrl: '', alerts })
    expect(valid.codeReview).toEqual({ gitlabUrl: '', alerts })
  })

  it('gives each default settings object its own copy', () => {
    const a = createDefaultSettings('en-US')
    const b = createDefaultSettings('en-US')
    expect(a.codeReview.alerts.github).not.toBe(b.codeReview.alerts.github)
    expect(a.codeReview.alerts.gitlab).not.toBe(DEFAULT_CODE_REVIEW_SETTINGS.alerts.gitlab)
  })

  it('accepts an empty or normalized https GitLab URL only', () => {
    expect(withCodeReview({ gitlabUrl: '', alerts })).toBe(true)
    expect(withCodeReview({ gitlabUrl: 'https://gitlab.x.com', alerts })).toBe(true)
    expect(withCodeReview({ gitlabUrl: 'https://gitlab.x.com/base', alerts })).toBe(true)
    for (const gitlabUrl of ['http://gitlab.x.com', 'https://gitlab.x.com/', 'https://u@gitlab.x.com', 'https://gitlab.x.com?a=1', 'nope']) {
      expect(withCodeReview({ gitlabUrl, alerts }), gitlabUrl).toBe(false)
    }
  })

  it('is strict about alerts', () => {
    expect(withCodeReview({ gitlabUrl: '', alerts: { github: alerts.github } })).toBe(false)
    expect(withCodeReview({ gitlabUrl: '', alerts: { ...alerts, github: { enabled: true } } })).toBe(false)
    expect(withCodeReview({ gitlabUrl: '', alerts: { ...alerts, github: { enabled: 'yes', sound: true } } })).toBe(false)
    expect(withCodeReview({ gitlabUrl: '', alerts: { ...alerts, x: alerts.github } })).toBe(false)
    expect(withCodeReview({ gitlabUrl: '', alerts, x: 1 })).toBe(false)
  })

  it('accepts a codeReview patch', () => {
    const patch = { codeReview: { gitlabUrl: 'https://gitlab.x.com', alerts } }
    expect(settingsPatchSchema.parse(patch)).toEqual(patch)
  })
})

describe('redmine settings', () => {
  const valid = createDefaultSettings('en-US')
  const endOfDay = { enabled: true, time: '18:00', sound: true }
  const withRedmine = (redmine: unknown) => settingsSchema.safeParse({ ...valid, redmine }).success

  it('has the documented defaults', () => {
    const expected = { url: '', dailyTargetHours: 8, endOfDay }
    expect(DEFAULT_REDMINE_SETTINGS).toEqual(expected)
    expect(valid.redmine).toEqual(expected)
    expect(valid.redmine.endOfDay).not.toBe(DEFAULT_REDMINE_SETTINGS.endOfDay)
  })

  it('accepts an empty or normalized https URL only', () => {
    expect(withRedmine({ url: 'https://r.x.com/base', dailyTargetHours: 8, endOfDay })).toBe(true)
    for (const url of ['http://r.x.com', 'https://r.x.com/', 'https://u@r.x.com', 'nope']) {
      expect(withRedmine({ url, dailyTargetHours: 8, endOfDay }), url).toBe(false)
    }
  })

  it('limits the target to 1-24 in half-hour steps', () => {
    for (const dailyTargetHours of [1, 7.5, 24]) expect(withRedmine({ url: '', dailyTargetHours, endOfDay }), String(dailyTargetHours)).toBe(true)
    for (const dailyTargetHours of [0, 0.5, 24.5, 7.25, 25]) expect(withRedmine({ url: '', dailyTargetHours, endOfDay }), String(dailyTargetHours)).toBe(false)
  })

  it('needs an HH:mm end-of-day time', () => {
    for (const time of ['00:00', '17:30', '23:59']) expect(withRedmine({ url: '', dailyTargetHours: 8, endOfDay: { ...endOfDay, time } }), time).toBe(true)
    for (const time of ['24:00', '9:00', '18:60', '1800', '']) expect(withRedmine({ url: '', dailyTargetHours: 8, endOfDay: { ...endOfDay, time } }), time).toBe(false)
  })

  it('accepts partial patches one level and two levels deep', () => {
    expect(settingsPatchSchema.parse({ redmine: { dailyTargetHours: 6 } })).toEqual({ redmine: { dailyTargetHours: 6 } })
    expect(settingsPatchSchema.parse({ redmine: { endOfDay: { time: '17:30' } } })).toEqual({ redmine: { endOfDay: { time: '17:30' } } })
    expect(settingsPatchSchema.safeParse({ redmine: { endOfDay: { time: '99:99' } } }).success).toBe(false)
  })
})

describe('integrations (v9)', () => {
  it('is version 10', () => {
    expect(SETTINGS_VERSION).toBe(10)
  })

  it('defaults: all enabled, capsule only for the six capsule integrations (the work log starts off)', () => {
    const integrations = createDefaultSettings('es').integrations
    expect(integrations).toEqual(cloneDefaultIntegrations())
    expect(integrations).toEqual({
      claude: { enabled: true, capsule: true, color: 'clay' },
      github: { enabled: true, capsule: true, color: 'green' },
      gitlab: { enabled: true, capsule: true, color: 'orange' },
      gmail: { enabled: true, capsule: true, color: 'salmon' },
      redmine: { enabled: true, capsule: true, color: 'pink' },
      workLog: { enabled: false, capsule: true, color: 'cyan' },
      reminders: { enabled: true, capsule: false, color: 'blue' },
      notes: { enabled: true, capsule: false, color: 'violet' },
    })
    expect(cloneDefaultIntegrations().claude).not.toBe(cloneDefaultIntegrations().claude)
  })

  it('rejects capsule on notes and reminders', () => {
    for (const key of ['notes', 'reminders'] as const) {
      const settings = createDefaultSettings('es')
      settings.integrations[key].capsule = true
      expect(settingsSchema.safeParse(settings).success, key).toBe(false)
    }
  })

  it('rejects a color that is neither a palette id nor uppercase #RRGGBB', () => {
    for (const color of ['magenta', '#4ade80', '#12345', '4ADE80', '']) {
      const settings = createDefaultSettings('es')
      ;(settings.integrations.gmail as { color: string }).color = color
      expect(settingsSchema.safeParse(settings).success, color).toBe(false)
    }
  })

  it('accepts a custom color as uppercase #RRGGBB', () => {
    const settings = createDefaultSettings('es')
    settings.integrations.gmail.color = '#A3B18A'
    expect(settingsSchema.parse(settings).integrations.gmail.color).toBe('#A3B18A')
    expect(settingsPatchSchema.safeParse({ integrations: { gmail: { color: '#A3B18A' } } }).success).toBe(true)
    expect(settingsPatchSchema.safeParse({ integrations: { gmail: { color: '#a3b18a' } } }).success).toBe(false)
  })

  it('accepts partial per-key, per-field patches', () => {
    expect(settingsPatchSchema.safeParse({ integrations: { gmail: { color: 'blue' } } }).success).toBe(true)
    expect(settingsPatchSchema.safeParse({ integrations: { notes: { enabled: false } } }).success).toBe(true)
    expect(settingsPatchSchema.safeParse({ integrations: { gmail: { color: 'nope' } } }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ integrations: { nope: { enabled: true } } }).success).toBe(false)
  })

  it('no longer has a system integration (v9)', () => {
    const settings = createDefaultSettings('es')
    expect(Object.keys(settings.integrations)).not.toContain('system')
    const withSystem = { ...settings, integrations: { ...settings.integrations, system: { enabled: true, capsule: false, color: 'teal' } } }
    expect(settingsSchema.safeParse(withSystem).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ integrations: { system: { enabled: false } } }).success).toBe(false)
  })
})

describe('work log settings (v10)', () => {
  it('defaults to no account and a 30 minute idle pause', () => {
    expect(createDefaultSettings('es').workLog).toEqual({ accountId: null, idlePauseMinutes: 30 })
  })

  it('accepts a linked account id and an idle pause of 5 to 240 minutes', () => {
    const withWorkLog = (workLog: unknown) => settingsSchema.safeParse({ ...createDefaultSettings('es'), workLog }).success
    expect(withWorkLog({ accountId: 'claude-work', idlePauseMinutes: 5 })).toBe(true)
    expect(withWorkLog({ accountId: null, idlePauseMinutes: 240 })).toBe(true)
    for (const idlePauseMinutes of [4, 241, 30.5, '30']) expect(withWorkLog({ accountId: null, idlePauseMinutes }), String(idlePauseMinutes)).toBe(false)
    expect(withWorkLog({ accountId: 'Not An Id', idlePauseMinutes: 30 })).toBe(false)
    expect(withWorkLog({ idlePauseMinutes: 30 })).toBe(false)
    expect(withWorkLog({ accountId: null, idlePauseMinutes: 30, extra: 1 })).toBe(false)
  })

  it('lets the renderer patch the work log and its integration entry, one field at a time', () => {
    expect(settingsPatchSchema.parse({ workLog: { idlePauseMinutes: 45 } })).toEqual({ workLog: { idlePauseMinutes: 45 } })
    expect(settingsPatchSchema.parse({ workLog: { accountId: null } })).toEqual({ workLog: { accountId: null } })
    expect(settingsPatchSchema.safeParse({ workLog: { idlePauseMinutes: 4 } }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ integrations: { workLog: { enabled: true, capsule: false } } }).success).toBe(true)
  })
})

describe('claude accounts (v10)', () => {
  const valid = createDefaultSettings('es')
  const withAccounts = (claudeAccounts: unknown) => settingsSchema.safeParse({ ...valid, claudeAccounts }).success

  it('defaults to nothing linked and not initialized', () => {
    expect(valid.claudeAccounts).toEqual({ linked: [], extraDirs: [], initialized: false })
  })

  it('takes account ids and existing-looking folders only', () => {
    expect(withAccounts({ linked: ['claude', 'claude-work', 'dir-0123abcd'], extraDirs: ['D:/Claude'], initialized: true })).toBe(true)
    expect(withAccounts({ linked: ['Claude'], extraDirs: [], initialized: true })).toBe(false)
    expect(withAccounts({ linked: ['a'.repeat(65)], extraDirs: [], initialized: true })).toBe(false)
    expect(withAccounts({ linked: [], extraDirs: [''], initialized: true })).toBe(false)
    expect(withAccounts({ linked: [], extraDirs: [], initialized: true, extra: 1 })).toBe(false)
    expect(withAccounts({ linked: Array.from({ length: 33 }, (_, i) => `claude-${i}`), extraDirs: [], initialized: true })).toBe(false)
  })

  it('is never part of a settings patch', () => {
    expect(settingsPatchSchema.safeParse({ claudeAccounts: valid.claudeAccounts }).success).toBe(false)
  })
})
