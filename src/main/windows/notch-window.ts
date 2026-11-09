import { BrowserWindow } from 'electron'
import { secureWebPreferences } from './secure-window'

export interface NotchWindowOptions {
  preloadPath: string
  /** Dev server URL in development; undefined in production builds. */
  devServerUrl: string | undefined
  rendererFile: string
  devTools: boolean
  onLoadFailed: (error: unknown) => void
}

/**
 * Temporary plain window for the skeleton. The transparent, always-on-top capsule
 * replaces it once the M0 spike has validated the window strategy.
 */
export function createNotchWindow(options: NotchWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 440,
    height: 180,
    show: false,
    resizable: false,
    maximizable: false,
    title: 'Developer Notch',
    backgroundColor: '#0E0E10',
    autoHideMenuBar: true,
    webPreferences: secureWebPreferences({ preload: options.preloadPath, devTools: options.devTools }),
  })

  window.once('ready-to-show', () => window.show())

  const load = options.devServerUrl
    ? window.loadURL(new URL('notch/index.html', options.devServerUrl.replace(/\/*$/, '/')).toString())
    : window.loadFile(options.rendererFile)
  load.catch(options.onLoadFailed)

  return window
}
