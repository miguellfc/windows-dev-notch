import { BrowserWindow } from 'electron'
import { secureWebPreferences } from './secure-window'

export interface ControlCenterOptions {
  preloadPath: string
  devServerUrl: string | undefined
  rendererFile: string
  devTools: boolean
  onLoadFailed: (error: unknown) => void
}

let current: BrowserWindow | null = null

export function controlCenterWindow(): BrowserWindow | null {
  return current && !current.isDestroyed() ? current : null
}

/** Opens the Control Center, or focuses it if it is already open. Uses Windows 11 Mica. */
export function openControlCenter(options: ControlCenterOptions): BrowserWindow {
  const existing = controlCenterWindow()
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return existing
  }

  const window = new BrowserWindow({
    width: 760,
    height: 520,
    minWidth: 640,
    minHeight: 440,
    title: 'Control Center · Developer Notch',
    show: false,
    backgroundMaterial: 'mica',
    backgroundColor: '#00000000',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#EDEDEF', height: 40 },
    autoHideMenuBar: true,
    webPreferences: secureWebPreferences({ preload: options.preloadPath, devTools: options.devTools }),
  })
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (current === window) current = null
  })

  const load = options.devServerUrl
    ? window.loadURL(new URL('control-center/index.html', options.devServerUrl.replace(/\/*$/, '/')).toString())
    : window.loadFile(options.rendererFile)
  load.catch(options.onLoadFailed)

  current = window
  return window
}
