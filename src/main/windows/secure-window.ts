import type { Session, WebContents, WebPreferences } from 'electron'
import { urlForLog, type Logger } from '../services/logger'

export interface SecurePreferencesOptions {
  preload: string
  devTools: boolean
}

/** The only webPreferences any window in this app may use. */
export function secureWebPreferences({ preload, devTools }: SecurePreferencesOptions): WebPreferences {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
    devTools,
  }
}

/** Blocks every way a page could leave the app: navigation (any frame), redirects, popups and webviews. */
export function hardenWebContents(contents: WebContents, logger: Logger): void {
  const log = logger.child('security')
  const block =
    (kind: string) =>
    (event: { preventDefault(): void; url?: string }, url?: string): void => {
      event.preventDefault()
      log.warn(`Blocked ${kind}`, { url: urlForLog(url ?? event.url) })
    }

  contents.on('will-navigate', block('navigation'))
  contents.on('will-frame-navigate', block('frame navigation'))
  contents.on('will-redirect', block('redirect'))
  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
    log.warn('Blocked webview attachment')
  })
  contents.setWindowOpenHandler(({ url }) => {
    log.warn('Blocked window.open', { url: urlForLog(url) })
    return { action: 'deny' }
  })
}

/** The app needs no browser permissions (camera, mic, notifications via web API, USB…): deny all. */
export function denyAllPermissions(session: Session): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
  session.setDevicePermissionHandler(() => false)
}
