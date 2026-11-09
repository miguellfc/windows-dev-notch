/** The part of Electron's `app` this module needs. */
export interface LoginItemHost {
  readonly isPackaged: boolean
  setLoginItemSettings(settings: { openAtLogin: boolean }): void
  getLoginItemSettings(): { openAtLogin: boolean }
}

export type LaunchAtLoginResult = { applied: true } | { applied: false; reason: 'not-packaged' | 'rejected' }

/**
 * Mirrors the "start with Windows" setting into the OS. Development builds are skipped:
 * registering them would launch the bare Electron binary at login.
 */
export function syncLaunchAtLogin(enabled: boolean, host: LoginItemHost): LaunchAtLoginResult {
  if (!host.isPackaged) return { applied: false, reason: 'not-packaged' }
  host.setLoginItemSettings({ openAtLogin: enabled })
  return host.getLoginItemSettings().openAtLogin === enabled ? { applied: true } : { applied: false, reason: 'rejected' }
}
