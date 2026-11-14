import { z } from 'zod'
import { GITLAB_URL_MAX, isStoredGitlabUrl } from '../code-review/schema'
import { isSafeAccelerator } from './accelerator'

export const SETTINGS_VERSION = 6

export const DEFAULT_REMINDERS_SETTINGS = { snoozeMinutes: 10, sound: true } as const

/** Empty OAuth client (what v4 introduced); v5 adds `alerts` next to it. */
export const DEFAULT_GMAIL_SETTINGS = { clientId: '', clientSecret: '' } as const

export const DEFAULT_GMAIL_ALERTS = { enabled: true, hideContent: false, sound: true } as const

/** v6: no GitLab server yet, first-review alerts with sound on for both platforms. */
export const DEFAULT_CODE_REVIEW_SETTINGS = {
  gitlabUrl: '',
  alerts: { github: { enabled: true, sound: true }, gitlab: { enabled: true, sound: true } },
} as const

export const DEFAULT_SYSTEM_ALERTS = {
  cpu: { enabled: true, percent: 90, sustainSeconds: 30 },
  ram: { enabled: true, percent: 90 },
  battery: { enabled: true, percent: 15 },
  disk: { enabled: true, freePercent: 10 },
} as const

export const languageSchema = z.enum(['es', 'en'])
export type Language = z.infer<typeof languageSchema>

/**
 * Electron accelerator such as `Control+Alt+Space`: keys joined by `+`, letters and digits only,
 * with Ctrl, Alt or Win plus a real key (never a bare key that every app would lose).
 */
const shortcutSchema = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9]+(\+[A-Za-z0-9]+)*$/, 'Invalid shortcut')
  .refine(isSafeAccelerator, 'Shortcut needs Ctrl, Alt or Win plus a key')

export const SNOOZE_MINUTES_OPTIONS = [5, 10, 15, 30] as const

export const remindersSettingsSchema = z.strictObject({
  snoozeMinutes: z.literal(SNOOZE_MINUTES_OPTIONS),
  sound: z.boolean(),
})

/** Thresholds of the capsule's system alerts; ranges keep the 5-point hysteresis meaningful. */
export const systemAlertSettingsSchema = z.strictObject({
  cpu: z.strictObject({
    enabled: z.boolean(),
    percent: z.int().min(50).max(100),
    sustainSeconds: z.int().min(5).max(300),
  }),
  ram: z.strictObject({ enabled: z.boolean(), percent: z.int().min(50).max(99) }),
  battery: z.strictObject({ enabled: z.boolean(), percent: z.int().min(5).max(50) }),
  disk: z.strictObject({ enabled: z.boolean(), freePercent: z.int().min(1).max(50) }),
})
export type SystemAlertSettings = z.infer<typeof systemAlertSettingsSchema>

/** New-mail alert in the capsule: on/off, hide sender and subject, chime. */
export const gmailAlertSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  hideContent: z.boolean(),
  sound: z.boolean(),
})
export type GmailAlertSettings = z.infer<typeof gmailAlertSettingsSchema>

/** OAuth desktop client the user created in Google Cloud (empty means Gmail is not configured) and the alerts. */
export const gmailSettingsSchema = z.strictObject({
  clientId: z.string().max(256),
  clientSecret: z.string().max(256),
  alerts: gmailAlertSettingsSchema,
})
export type GmailSettings = z.infer<typeof gmailSettingsSchema>

/** First-review alert of one platform: on/off and chime. */
export const codeReviewAlertSettingsSchema = z.strictObject({ enabled: z.boolean(), sound: z.boolean() })
export type CodeReviewAlertSettings = z.infer<typeof codeReviewAlertSettingsSchema>

/** GitHub/GitLab: the GitLab server (`''` = not configured; stored normalized, https only) and the alerts. */
export const codeReviewSettingsSchema = z.strictObject({
  gitlabUrl: z.string().max(GITLAB_URL_MAX).refine(isStoredGitlabUrl, 'GitLab URL must be empty or a normalized https URL'),
  alerts: z.strictObject({ github: codeReviewAlertSettingsSchema, gitlab: codeReviewAlertSettingsSchema }),
})
export type CodeReviewSettings = z.infer<typeof codeReviewSettingsSchema>

export const settingsSchema = z.strictObject({
  version: z.literal(SETTINGS_VERSION),
  language: languageSchema,
  shortcut: shortcutSchema,
  launchAtLogin: z.boolean(),
  reminders: remindersSettingsSchema,
  systemAlerts: systemAlertSettingsSchema,
  gmail: gmailSettingsSchema,
  codeReview: codeReviewSettingsSchema,
})
export type Settings = z.infer<typeof settingsSchema>

/** What the renderer may change: any subset of user fields, never the version. */
export const settingsPatchSchema = settingsSchema
  .omit({ version: true })
  // The store merges codeReview one level deep: a patch of its alerts never restores a stale gitlabUrl.
  .extend({ codeReview: codeReviewSettingsSchema.partial() })
  .partial()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), 'Empty settings patch')
export type SettingsPatch = z.infer<typeof settingsPatchSchema>

/** A fresh, mutable copy: callers never share the frozen-shaped defaults object. */
export function cloneDefaultSystemAlerts(): SystemAlertSettings {
  return {
    cpu: { ...DEFAULT_SYSTEM_ALERTS.cpu },
    ram: { ...DEFAULT_SYSTEM_ALERTS.ram },
    battery: { ...DEFAULT_SYSTEM_ALERTS.battery },
    disk: { ...DEFAULT_SYSTEM_ALERTS.disk },
  }
}

/** A fresh, mutable copy of the code review defaults. */
export function cloneDefaultCodeReviewSettings(): CodeReviewSettings {
  return {
    gitlabUrl: DEFAULT_CODE_REVIEW_SETTINGS.gitlabUrl,
    alerts: {
      github: { ...DEFAULT_CODE_REVIEW_SETTINGS.alerts.github },
      gitlab: { ...DEFAULT_CODE_REVIEW_SETTINGS.alerts.gitlab },
    },
  }
}

export function languageFromLocale(locale: string): Language {
  return locale.toLowerCase().startsWith('es') ? 'es' : 'en'
}

export function createDefaultSettings(locale: string): Settings {
  return {
    version: SETTINGS_VERSION,
    language: languageFromLocale(locale),
    shortcut: 'Control+Alt+Space',
    launchAtLogin: false,
    reminders: { ...DEFAULT_REMINDERS_SETTINGS },
    systemAlerts: cloneDefaultSystemAlerts(),
    gmail: { ...DEFAULT_GMAIL_SETTINGS, alerts: { ...DEFAULT_GMAIL_ALERTS } },
    codeReview: cloneDefaultCodeReviewSettings(),
  }
}
