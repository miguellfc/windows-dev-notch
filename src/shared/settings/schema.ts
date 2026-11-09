import { z } from 'zod'

export const SETTINGS_VERSION = 1

export const languageSchema = z.enum(['es', 'en'])
export type Language = z.infer<typeof languageSchema>

/** Electron accelerator such as `Control+Alt+Space`: keys joined by `+`, letters and digits only. */
const shortcutSchema = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9]+(\+[A-Za-z0-9]+)*$/, 'Invalid shortcut')

export const settingsSchema = z.strictObject({
  version: z.literal(SETTINGS_VERSION),
  language: languageSchema,
  shortcut: shortcutSchema,
  launchAtLogin: z.boolean(),
})
export type Settings = z.infer<typeof settingsSchema>

/** What the renderer may change: any subset of user fields, never the version. */
export const settingsPatchSchema = settingsSchema
  .omit({ version: true })
  .partial()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), 'Empty settings patch')
export type SettingsPatch = z.infer<typeof settingsPatchSchema>

export function languageFromLocale(locale: string): Language {
  return locale.toLowerCase().startsWith('es') ? 'es' : 'en'
}

export function createDefaultSettings(locale: string): Settings {
  return {
    version: SETTINGS_VERSION,
    language: languageFromLocale(locale),
    shortcut: 'Control+Alt+Space',
    launchAtLogin: false,
  }
}
