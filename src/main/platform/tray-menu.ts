import { translate } from '../../shared/i18n/messages'
import type { Language } from '../../shared/settings/schema'

export type TrayMenuItem =
  | { type: 'separator' }
  | { label: string; type?: 'normal' | 'checkbox'; checked?: boolean; enabled?: boolean; click?: () => void }

export interface TrayMenuOptions {
  language: Language
  notchVisible: boolean
  launchAtLogin: boolean
  launchAtLoginAvailable: boolean
  actions: {
    toggleVisibility(): void
    openControlCenter(): void
    setLaunchAtLogin(enabled: boolean): void
    quit(): void
  }
}

/** Pure description of the tray menu; the Electron glue turns it into a Menu. */
export function buildTrayMenu({
  language,
  notchVisible,
  launchAtLogin,
  launchAtLoginAvailable,
  actions,
}: TrayMenuOptions): TrayMenuItem[] {
  const t = (key: Parameters<typeof translate>[1]) => translate(language, key)
  return [
    { label: t(notchVisible ? 'tray.hide' : 'tray.show'), click: actions.toggleVisibility },
    { label: t('tray.controlCenter'), click: actions.openControlCenter },
    { type: 'separator' },
    {
      label: t('tray.launchAtLogin'),
      type: 'checkbox',
      checked: launchAtLogin,
      enabled: launchAtLoginAvailable,
      click: () => actions.setLaunchAtLogin(!launchAtLogin),
    },
    { type: 'separator' },
    { label: t('tray.quit'), click: actions.quit },
  ]
}
