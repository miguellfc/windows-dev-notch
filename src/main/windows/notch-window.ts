import { BrowserWindow } from 'electron'
import { windowBoundsFor, type Rect } from '../../shared/notch/geometry'
import { emitEvent } from '../ipc/events'
import type { Logger } from '../services/logger'
import type { NotchSurface } from './notch-controller'
import { secureWebPreferences } from './secure-window'

export interface NotchWindowOptions {
  preloadPath: string
  /** Dev server URL in development; undefined in production builds. */
  devServerUrl: string | undefined
  rendererFile: string
  devTools: boolean
  workArea: Rect
  logger: Logger
  /** Allows the window to close only when the app is quitting. */
  isQuitting: () => boolean
  onLoadFailed: (error: unknown) => void
}

/** Native handle as the string koffi reports, used to recognise our own window. */
export function nativeHandle(window: BrowserWindow): string {
  return window.getNativeWindowHandle().readBigUInt64LE(0).toString()
}

/**
 * The capsule window: transparent, frameless, always on top, as wide as the widest capsule plus
 * its shadow and as tall as the current one (M0 strategy A). Clicks pass through the transparent
 * area: the window ignores the mouse (forwarding moves) unless the pointer is over the capsule.
 */
export function createNotchWindow(options: NotchWindowOptions): { window: BrowserWindow; surface: NotchSurface } {
  const window = new BrowserWindow({
    // The resting capsule (time and date); the controller sizes the window for the real mode on start.
    ...windowBoundsFor('peek', options.workArea),
    title: 'Developer Notch',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: secureWebPreferences({ preload: options.preloadPath, devTools: options.devTools }),
  })
  window.setAlwaysOnTop(true, 'screen-saver')
  window.on('close', (event) => {
    if (!options.isQuitting()) event.preventDefault()
  })

  const load = options.devServerUrl
    ? window.loadURL(new URL('notch/index.html', options.devServerUrl.replace(/\/*$/, '/')).toString())
    : window.loadFile(options.rendererFile)
  load.catch(options.onLoadFailed)

  // Every call is a no-op once the window is gone (e.g. a timer firing while quitting).
  const live =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A) => {
      if (!window.isDestroyed()) fn(...args)
    }
  const surface: NotchSurface = {
    setBounds: live((rect) => window.setBounds(rect)),
    show: live(() => window.showInactive()),
    hide: live(() => window.hide()),
    focus: live(() => window.focus()),
    blur: live(() => window.blur()),
    setIgnoreMouse: live((ignore: boolean) => window.setIgnoreMouseEvents(ignore, { forward: true })),
    sendMode: live((mode: Parameters<NotchSurface['sendMode']>[0]) =>
      emitEvent([window.webContents], 'notch:mode-changed', mode, options.logger),
    ),
    sendMailAlert: live((on: boolean) => emitEvent([window.webContents], 'notch:mail-alert', on, options.logger)),
    sendReviewAlert: live((on: boolean) => emitEvent([window.webContents], 'notch:review-alert', on, options.logger)),
  }

  return { window, surface }
}
