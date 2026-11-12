import { z } from 'zod'
import { isSafeAccelerator } from './accelerator'

export const SETTINGS_VERSION = 4

export const DEFAULT_REMINDERS_SETTINGS = { snoozeMinutes: 10, sound: true } as const

export const DEFAULT_GMAIL_SETTINGS = { clientId: '', clientSecret: '' } as const

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

/** OAuth desktop client the user created in Google Cloud; empty means Gmail is not configured. */
export const gmailSettingsSchema = z.strictObject({
  clientId: z.string().max(256),
  clientSecret: z.string().max(256),
})
export type GmailSettings = z.infer<typeof gmailSettingsSchema>

export const settingsSchema = z.strictObject({
  version: z.literal(SETTINGS_VERSION),
  language: languageSchema,
  shortcut: shortcutSchema,
  launchAtLogin: z.boolean(),
  reminders: remindersSettingsSchema,
  systemAlerts: systemAlertSettingsSchema,
  gmail: gmailSettingsSchema,
})
export type Settings = z.infer<typeof settingsSchema>

/** What the renderer may change: any subset of user fields, never the version. */
export const settingsPatchSchema = settingsSchema
  .omit({ version: true })
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
    gmail: { ...DEFAULT_GMAIL_SETTINGS },
  }
}
