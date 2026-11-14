import type { Settings, SettingsPatch } from '../../shared/settings/schema'
import { ExposedIpcError } from '../ipc/errors'
import type { ShortcutService } from '../platform/shortcut'
import type { Logger } from './logger'

export interface SettingsUpdaterDeps {
  settings: { update(patch: SettingsPatch): Promise<Settings> }
  shortcut: ShortcutService
  syncLaunchAtLogin: (enabled: boolean) => void
  logger: Logger
}

/**
 * Applies a settings patch with its side effects. The shortcut is registered first (so a
 * taken combination is never saved) and rolled back if saving fails, keeping the registered
 * shortcut and the saved one in sync. Start with Windows is applied after a successful save
 * and never undoes it.
 */
export function createSettingsUpdater(deps: SettingsUpdaterDeps): (patch: SettingsPatch) => Promise<Settings> {
  const { settings, shortcut, syncLaunchAtLogin } = deps
  const log = deps.logger.child('settings')

  const rollbackShortcut = (previous: string | null) => {
    if (shortcut.current() === previous) return
    if (previous === null) {
      shortcut.dispose()
      return
    }
    const restored = shortcut.apply(previous)
    if (!restored.ok) log.error('Could not roll back the global shortcut', { previous, reason: restored.reason })
  }

  return async (patch) => {
    const previous = shortcut.current()
    if (patch.shortcut !== undefined) {
      const result = shortcut.apply(patch.shortcut)
      if (!result.ok) {
        throw result.reason === 'unavailable'
          ? new ExposedIpcError('UNAVAILABLE', 'Shortcut is used by another application')
          : new ExposedIpcError('INVALID_INPUT', 'Shortcut is not valid')
      }
    }

    let saved: Settings
    try {
      saved = await settings.update(patch)
    } catch (error) {
      rollbackShortcut(previous)
      throw error
    }

    if (patch.launchAtLogin !== undefined) {
      try {
        syncLaunchAtLogin(saved.launchAtLogin)
      } catch (error) {
        log.error('Could not apply start with Windows', { error })
      }
    }
    return saved
  }
}
