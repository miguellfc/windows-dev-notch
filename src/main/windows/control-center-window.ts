import { BrowserWindow } from 'electron'
import type { ControlCenterPage } from '../../shared/ipc/contract'
import { secureWebPreferences } from './secure-window'

export interface ControlCenterOptions {
  preloadPath: string
  devServerUrl: string | undefined
  rendererFile: string
  devTools: boolean
  onLoadFailed: (error: unknown) => void
  /** An open window could not be moved to `page`; it stays on the page it shows. */
  onPageFailed: (error: unknown) => void
  /**
   * Page to show, as the URL hash: a new window loads with it; an open one is navigated to it once
   * loaded (a same-document hash change, never a reload, which would abort a running load). The renderer
   * reads it at start and on `hashchange`, then clears it, so asking twice for one page still works.
   */
  page?: ControlCenterPage
}

let current: BrowserWindow | null = null

export function controlCenterWindow(): BrowserWindow | null {
  return current && !current.isDestroyed() ? current : null
}

/** Opens the Control Center, or focuses it if it is already open. Uses Windows 11 Mica. */
export function openControlCenter(options: ControlCenterOptions): BrowserWindow {
  const existing = controlCenterWindow()
  if (existing) {
    if (options.page) showPage(existing, options)
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

  load(window, options)
  current = window
  return window
}

function navigate(window: BrowserWindow, options: ControlCenterOptions): Promise<void> {
  const hash = options.page ?? ''
  return options.devServerUrl
    ? window.loadURL(`${new URL('control-center/index.html', options.devServerUrl.replace(/\/*$/, '/')).toString()}${hash ? `#${hash}` : ''}`)
    : window.loadFile(options.rendererFile, hash ? { hash } : undefined)
}

function load(window: BrowserWindow, options: ControlCenterOptions): void {
  navigate(window, options).catch(options.onLoadFailed)
}

/** Moves an open window to `options.page`; one still loading gets it as soon as it has loaded. */
function showPage(window: BrowserWindow, options: ControlCenterOptions): void {
  const go = () => {
    if (!window.isDestroyed()) navigate(window, options).catch(options.onPageFailed)
  }
  if (window.webContents.isLoading()) window.webContents.once('did-finish-load', go)
  else go()
}
