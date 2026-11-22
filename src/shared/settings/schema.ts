import { z } from 'zod'
import { GITLAB_URL_MAX, isStoredGitlabUrl } from '../code-review/schema'
import { REDMINE_URL_MAX, isStoredRedmineUrl } from '../redmine/url'
import {
  DEFAULT_INTEGRATION_COLORS,
  HEX_COLOR,
  capsuleIntegrationKeys,
  integrationColorIds,
  integrationKeys,
  type IntegrationKey,
} from '../integrations/colors'
import { isSafeAccelerator } from './accelerator'

/** v10: `claudeAccounts` (the Claude Code accounts the notch installs its hooks in). v9 dropped `integrations.system`. */
export const SETTINGS_VERSION = 10

export const DEFAULT_REMINDERS_SETTINGS = { snoozeMinutes: 10, sound: true } as const

/** Empty OAuth client (what v4 introduced); v5 adds `alerts` next to it. */
export const DEFAULT_GMAIL_SETTINGS = { clientId: '', clientSecret: '' } as const

export const DEFAULT_GMAIL_ALERTS = { enabled: true, hideContent: false, sound: true } as const

/** v6: no GitLab server yet, first-review alerts with sound on for both platforms. */
export const DEFAULT_CODE_REVIEW_SETTINGS = {
  gitlabUrl: '',
  alerts: { github: { enabled: true, sound: true }, gitlab: { enabled: true, sound: true } },
} as const

/** v7: no Redmine server yet, 8 h daily target and the weekday end-of-day alert at 18:00 with sound. */
export const DEFAULT_REDMINE_SETTINGS = {
  url: '',
  dailyTargetHours: 8,
  endOfDay: { enabled: true, time: '18:00', sound: true },
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

/** End-of-day alert: weekdays at `time` (local `HH:mm`), once a day, when today's hours are under the target. */
export const redmineEndOfDaySettingsSchema = z.strictObject({
  enabled: z.boolean(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:mm'),
  sound: z.boolean(),
})
export type RedmineEndOfDaySettings = z.infer<typeof redmineEndOfDaySettingsSchema>

/** Redmine: the server (`''` = not configured; stored normalized, https only), the daily target (1-24 in 0.5 steps) and the alert. */
export const redmineSettingsSchema = z.strictObject({
  url: z.string().max(REDMINE_URL_MAX).refine(isStoredRedmineUrl, 'Redmine URL must be empty or a normalized https URL'),
  dailyTargetHours: z
    .number()
    .min(1)
    .max(24)
    .refine((value) => Number.isInteger(value * 2), 'Target must be in steps of 0.5'),
  endOfDay: redmineEndOfDaySettingsSchema,
})
export type RedmineSettings = z.infer<typeof redmineSettingsSchema>

/** A palette id, or a custom color as uppercase `#RRGGBB`. */
export const integrationColorSchema = z.union([
  z.enum(integrationColorIds),
  z.custom<`#${string}`>((value) => typeof value === 'string' && HEX_COLOR.test(value), 'Color must be a palette id or #RRGGBB'),
])

/** One integration: on/off, whether it shows in the capsule, and its color (palette id or hex). */
export const integrationSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  capsule: z.boolean(),
  color: integrationColorSchema,
})
export type IntegrationSettings = z.infer<typeof integrationSettingsSchema>

const capsuleKeySet: ReadonlySet<IntegrationKey> = new Set(capsuleIntegrationKeys)

/** v9: the seven integrations (v8 also had `system`); only the capsule ones may have `capsule: true`. */
export const integrationsSettingsSchema = z
  .strictObject({
    claude: integrationSettingsSchema,
    github: integrationSettingsSchema,
    gitlab: integrationSettingsSchema,
    gmail: integrationSettingsSchema,
    redmine: integrationSettingsSchema,
    reminders: integrationSettingsSchema,
    notes: integrationSettingsSchema,
  })
  .refine(
    (integrations) => integrationKeys.every((key) => capsuleKeySet.has(key) || !integrations[key].capsule),
    'Reminders and notes have no capsule block',
  )
export type IntegrationsSettings = z.infer<typeof integrationsSettingsSchema>

/** Most linked accounts and extra folders kept. */
export const CLAUDE_ACCOUNTS_MAX = 32
export const CLAUDE_ACCOUNT_DIR_MAX = 1024

/**
 * v10: the Claude Code accounts (config folders). `linked`: ids whose hooks the user installed;
 * `extraDirs`: folders added by hand; `initialized`: the first start after the update linked
 * `~/.claude` if it already had our hooks. Only main changes it (never a settings patch).
 */
export const claudeAccountsSettingsSchema = z.strictObject({
  linked: z.array(z.string().regex(/^[a-z0-9-]{1,64}$/)).max(CLAUDE_ACCOUNTS_MAX),
  extraDirs: z.array(z.string().min(1).max(CLAUDE_ACCOUNT_DIR_MAX)).max(CLAUDE_ACCOUNTS_MAX),
  initialized: z.boolean(),
})
export type ClaudeAccountsSettings = z.infer<typeof claudeAccountsSettingsSchema>

export const settingsSchema = z.strictObject({
  version: z.literal(SETTINGS_VERSION),
  language: languageSchema,
  shortcut: shortcutSchema,
  launchAtLogin: z.boolean(),
  reminders: remindersSettingsSchema,
  systemAlerts: systemAlertSettingsSchema,
  gmail: gmailSettingsSchema,
  codeReview: codeReviewSettingsSchema,
  redmine: redmineSettingsSchema,
  integrations: integrationsSettingsSchema,
  claudeAccounts: claudeAccountsSettingsSchema,
})
export type Settings = z.infer<typeof settingsSchema>

/** What the renderer may change: any subset of user fields, never the version nor the Claude accounts. */
export const settingsPatchSchema = settingsSchema
  .omit({ version: true, claudeAccounts: true })
  // The store merges codeReview one level deep: a patch of its alerts never restores a stale gitlabUrl.
  // Same for redmine, and its endOfDay one level further down.
  .extend({
    codeReview: codeReviewSettingsSchema.partial(),
    redmine: redmineSettingsSchema.extend({ endOfDay: redmineEndOfDaySettingsSchema.partial() }).partial(),
    // Per integration and per field, so recoloring one never touches the others.
    integrations: z
      .strictObject({
        claude: integrationSettingsSchema.partial(),
        github: integrationSettingsSchema.partial(),
        gitlab: integrationSettingsSchema.partial(),
        gmail: integrationSettingsSchema.partial(),
        redmine: integrationSettingsSchema.partial(),
        reminders: integrationSettingsSchema.partial(),
        notes: integrationSettingsSchema.partial(),
      })
      .partial(),
  })
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

/** A fresh, mutable copy of the Redmine defaults. */
export function cloneDefaultRedmineSettings(): RedmineSettings {
  return {
    url: DEFAULT_REDMINE_SETTINGS.url,
    dailyTargetHours: DEFAULT_REDMINE_SETTINGS.dailyTargetHours,
    endOfDay: { ...DEFAULT_REDMINE_SETTINGS.endOfDay },
  }
}

/** A fresh, mutable copy of the integration defaults: all on, capsule only where it exists. */
export function cloneDefaultIntegrations(): IntegrationsSettings {
  const entry = (key: IntegrationKey): IntegrationSettings => ({
    enabled: true,
    capsule: capsuleKeySet.has(key),
    color: DEFAULT_INTEGRATION_COLORS[key],
  })
  return {
    claude: entry('claude'),
    github: entry('github'),
    gitlab: entry('gitlab'),
    gmail: entry('gmail'),
    redmine: entry('redmine'),
    reminders: entry('reminders'),
    notes: entry('notes'),
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
    redmine: cloneDefaultRedmineSettings(),
    integrations: cloneDefaultIntegrations(),
    claudeAccounts: { linked: [], extraDirs: [], initialized: false },
  }
}
