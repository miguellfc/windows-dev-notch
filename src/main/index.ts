import { join } from 'node:path'
import { app, ipcMain, session, type BrowserWindow } from 'electron'
import { DEV_CSP } from '../shared/security/csp'
import { createDefaultSettings } from '../shared/settings/schema'
import { registerIpc } from './ipc/register'
import { createSenderGuard } from './ipc/sender-guard'
import { createFileLogger } from './services/logger'
import { SettingsStore } from './services/settings-store'
import { createNotchWindow } from './windows/notch-window'
import { denyAllPermissions, hardenWebContents } from './windows/secure-window'

const APP_USER_MODEL_ID = 'dev.developernotch.app'

// Development-only switches. A packaged build ignores both, so nothing in the
// environment can point the installed app at another page or profile.
const devServerUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL']
const isolatedUserData = app.isPackaged ? undefined : process.env['NOTCH_USER_DATA_DIR']
if (isolatedUserData) app.setPath('userData', isolatedUserData)

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  start()
}

function start(): void {
  const logger = createFileLogger({
    dir: join(app.getPath('userData'), 'logs'),
    mirrorToConsole: !app.isPackaged,
  })
  let notchWindow: BrowserWindow | null = null

  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents, logger))

  app.on('second-instance', () => {
    if (!notchWindow) return
    if (notchWindow.isMinimized()) notchWindow.restore()
    notchWindow.show()
    notchWindow.focus()
  })

  app.on('window-all-closed', () => app.quit())

  app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId(APP_USER_MODEL_ID)
      denyAllPermissions(session.defaultSession)

      if (devServerUrl) {
        // Relaxed policy for Vite HMR, applied only to dev server responses.
        session.defaultSession.webRequest.onHeadersReceived(
          { urls: [`${new URL(devServerUrl).origin}/*`] },
          (details, callback) => {
            const headers = Object.fromEntries(
              Object.entries(details.responseHeaders ?? {}).filter(
                ([name]) => name.toLowerCase() !== 'content-security-policy',
              ),
            )
            callback({ responseHeaders: { ...headers, 'Content-Security-Policy': [DEV_CSP] } })
          },
        )
      }

      const settings = new SettingsStore({
        filePath: join(app.getPath('userData'), 'settings.json'),
        defaults: createDefaultSettings(app.getLocale()),
        logger,
      })
      await settings.load()

      registerIpc({
        ipcMain,
        logger,
        isTrustedUrl: createSenderGuard({ rendererDir: join(__dirname, '../renderer'), devServerUrl }),
        handlers: {
          'app:get-info': () => ({ name: app.getName(), version: app.getVersion(), platform: process.platform }),
          'settings:get': () => settings.get(),
          'settings:update': (patch) => settings.update(patch),
        },
      })

      notchWindow = createNotchWindow({
        preloadPath: join(__dirname, '../preload/index.js'),
        devServerUrl,
        rendererFile: join(__dirname, '../renderer/notch/index.html'),
        devTools: !app.isPackaged,
        onLoadFailed: (error) => {
          logger.error('Notch window failed to load', { error })
          app.quit()
        },
      })
      notchWindow.on('closed', () => {
        notchWindow = null
      })

      logger.info('Developer Notch started', { version: app.getVersion() })
    })
    .catch((error: unknown) => {
      logger.error('Startup failed', { error })
      app.quit()
    })
}
