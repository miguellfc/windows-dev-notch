import { Menu, Tray, nativeImage } from 'electron'
import trayIconPath from '../../../resources/tray.png?asset'
import { buildTrayMenu, type TrayMenuOptions } from './tray-menu'

export interface AppTray {
  refresh(): void
  destroy(): void
}

/** System tray icon. The menu is rebuilt from current state on every refresh. */
export function createAppTray(getOptions: () => TrayMenuOptions, onClick: () => void): AppTray {
  const tray = new Tray(nativeImage.createFromPath(trayIconPath))
  tray.setToolTip('Developer Notch')
  tray.on('click', onClick)

  const refresh = () => tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenu(getOptions())))
  refresh()

  return { refresh, destroy: () => tray.destroy() }
}
