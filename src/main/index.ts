import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, globalShortcut, ipcMain, screen, session, type Display } from 'electron'
import { DEV_CSP } from '../shared/security/csp'
import { createDefaultSettings, type Settings } from '../shared/settings/schema'
import { emitEvent } from './ipc/events'
import { registerIpc, type IpcEventLike } from './ipc/register'
import { createSenderGuard } from './ipc/sender-guard'
import { syncLaunchAtLogin } from './platform/auto-launch'
import { classifyForeground, type MonitorRect } from './platform/foreground-classifier'
import { createForegroundWatcher } from './platform/foreground-watcher'
import { createShortcutService } from './platform/shortcut'
import { createAppTray, type AppTray } from './platform/tray'
import { createWin32ForegroundProbe } from './platform/win32'
import { createFileLogger } from './services/logger'
import { SettingsStore } from './services/settings-store'
import { createSettingsUpdater } from './services/settings-update'
import { pathExists, resolveShell, shellEnvironment } from './terminal/shell-resolver'
import { createTerminalSession } from './terminal/terminal-session'
import { controlCenterWindow, openControlCenter } from './windows/control-center-window'
import { createNotchController } from './windows/notch-controller'
import { createNotchWindow, nativeHandle } from './windows/notch-window'
import { denyAllPermissions, hardenWebContents } from './windows/secure-window'

const APP_USER_MODEL_ID = 'dev.developernotch.app'

// Development-only switches. A packaged build ignores them all, so nothing in the
// environment can point the installed app at another page, profile or behaviour.
const devServerUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL']
const isolatedUserData = app.isPackaged ? undefined : process.env['NOTCH_USER_DATA_DIR']
const foregroundWatchDisabled = !app.isPackaged && process.env['NOTCH_DISABLE_FOREGROUND_WATCH'] === '1'
if (isolatedUserData) app.setPath('userData', isolatedUserData)

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  start()
}

function physicalRect(display: Display): MonitorRect {
  const r = screen.dipToScreenRect(null, display.bounds)
  return { left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height }
}

function start(): void {
  const logger = createFileLogger({ dir: join(app.getPath('userData'), 'logs'), mirrorToConsole: !app.isPackaged })
  let quitting = false

  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents, logger))
  app.on('before-quit', () => {
    quitting = true
  })
  // The app lives in the tray: closing windows never quits it.
  app.on('window-all-closed', () => undefined)

  app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId(APP_USER_MODEL_ID)
      denyAllPermissions(session.defaultSession)

      if (devServerUrl) {
        session.defaultSession.webRequest.onHeadersReceived(
          { urls: [`${new URL(devServerUrl).origin}/*`] },
          (details, callback) => {
            const headers = Object.fromEntries(
              Object.entries(details.responseHeaders ?? {}).filter(([name]) => name.toLowerCase() !== 'content-security-policy'),
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

      const rendererFile = (page: string) => join(__dirname, `../renderer/${page}/index.html`)
      const preloadPath = join(__dirname, '../preload/index.js')
      const onLoadFailed = (error: unknown) => {
        logger.error('A window failed to load', { error })
        app.quit()
      }

      // --- Capsule -------------------------------------------------------------------
      let display = screen.getPrimaryDisplay()
      const { window: notchWindow, surface } = createNotchWindow({
        preloadPath,
        devServerUrl,
        rendererFile: rendererFile('notch'),
        devTools: !app.isPackaged,
        workArea: display.workArea,
        logger,
        isQuitting: () => quitting,
        onLoadFailed,
      })
      let tray: AppTray | null = null
      const notch = createNotchController({
        surface,
        workArea: display.workArea,
        logger,
        onModeChange: () => tray?.refresh(),
      })
      notchWindow.once('ready-to-show', () => notch.start())
      notchWindow.on('blur', () => notch.dispatch({ type: 'dismiss' }))

      let watcher: ReturnType<typeof createForegroundWatcher> | null = null
      const moveToDisplay = (next: Display) => {
        display = next
        notch.setWorkArea(next.workArea)
        // The yield verdict depends on which monitor the capsule is on.
        watcher?.refresh()
      }
      const onDisplaysChanged = () => {
        const still = screen.getAllDisplays().find((d) => d.id === display.id)
        moveToDisplay(still ?? screen.getPrimaryDisplay())
      }
      screen.on('display-added', onDisplaysChanged)
      screen.on('display-removed', onDisplaysChanged)
      screen.on('display-metrics-changed', onDisplaysChanged)

      // --- Foreground watcher --------------------------------------------------------
      const probe = foregroundWatchDisabled ? null : createWin32ForegroundProbe(logger)
      const ownHandles = () => {
        const cc = controlCenterWindow()
        return cc ? [nativeHandle(notchWindow), nativeHandle(cc)] : [nativeHandle(notchWindow)]
      }
      watcher = probe
        ? createForegroundWatcher({
            logger,
            probe: () => classifyForeground(probe.snapshot(), { ownHandles: ownHandles(), notchMonitor: physicalRect(display) }),
            onChange: (verdict) => notch.dispatch({ type: 'foreground', verdict }),
          })
        : null
      watcher?.start()

      // --- Global shortcut -----------------------------------------------------------
      const shortcut = createShortcutService({
        registrar: globalShortcut,
        logger,
        onTrigger: () => {
          if (notch.mode() !== 'expanded') {
            const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
            if (cursorDisplay.id !== display.id) moveToDisplay(cursorDisplay)
          }
          notch.dispatch({ type: 'toggle' })
        },
      })
      const initialShortcut = shortcut.apply(settings.get().shortcut)
      if (!initialShortcut.ok) logger.warn('Saved shortcut could not be registered', { reason: initialShortcut.reason })

      syncLaunchAtLogin(settings.get().launchAtLogin, app)
      const updateSettings = createSettingsUpdater({
        settings,
        shortcut,
        syncLaunchAtLogin: (enabled) => syncLaunchAtLogin(enabled, app),
        logger,
      })

      // --- Control Center & tray -----------------------------------------------------
      const showControlCenter = () => {
        notch.dispatch({ type: 'dismiss' })
        openControlCenter({
          preloadPath,
          devServerUrl,
          rendererFile: rendererFile('control-center'),
          devTools: !app.isPackaged,
          onLoadFailed,
        })
      }

      tray = createAppTray(
        () => ({
          language: settings.get().language,
          notchVisible: notch.mode() !== 'hidden',
          launchAtLogin: settings.get().launchAtLogin,
          launchAtLoginAvailable: app.isPackaged,
          actions: {
            // "Show" must always show, even while a fullscreen app made the capsule yield.
            toggleVisibility: () =>
              notch.dispatch(notch.mode() === 'hidden' ? { type: 'expand' } : { type: 'user-visibility', hidden: true }),
            openControlCenter: showControlCenter,
            setLaunchAtLogin: (enabled) => {
              updateSettings({ launchAtLogin: enabled }).catch((error: unknown) =>
                logger.error('Could not change start with Windows', { error }),
              )
            },
            quit: () => app.quit(),
          },
        }),
        () => notch.dispatch({ type: 'expand' }),
      )

      settings.onChange((next: Settings) => {
        emitEvent(
          BrowserWindow.getAllWindows().map((w) => w.webContents),
          'settings:changed',
          next,
          logger,
        )
        tray?.refresh()
      })

      app.on('second-instance', () => notch.dispatch({ type: 'expand' }))

      // --- Terminal --------------------------------------------------------------------
      // One PowerShell session owned by main. Only the notch window may read or write it,
      // and only through the terminal:* channels below.
      const terminal = createTerminalSession({
        spawn: (file, args, options) => {
          // Loaded on first use so the native module costs nothing until the terminal opens.
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const pty = require('node-pty') as typeof import('node-pty')
          return pty.spawn(file, args, options)
        },
        shell: resolveShell({ exists: pathExists, env: process.env }),
        cwd: homedir(),
        env: shellEnvironment(process.env),
        // Output can still arrive while the app quits and the window is already gone.
        onData: (chunk) => {
          if (!notchWindow.isDestroyed()) emitEvent([notchWindow.webContents], 'terminal:data', chunk, logger)
        },
        onExit: (exitCode) => {
          if (!notchWindow.isDestroyed()) emitEvent([notchWindow.webContents], 'terminal:exit', { exitCode }, logger)
          // `exit` closes the terminal like closing a terminal window: the panel closes and focus
          // goes back to the previous app. The next open starts a new shell.
          if (notch.mode() === 'terminal') notch.dispatch({ type: 'dismiss' })
        },
        isViewing: () => notch.mode() === 'terminal',
        logger,
      })
      const fromNotchWindow = (event: IpcEventLike) =>
        !notchWindow.isDestroyed() && event.sender.id === notchWindow.webContents.id

      // --- IPC -----------------------------------------------------------------------
      registerIpc({
        ipcMain,
        logger,
        isTrustedUrl: createSenderGuard({ rendererDir: join(__dirname, '../renderer'), devServerUrl }),
        channelGuards: {
          'terminal:open': fromNotchWindow,
          'terminal:input': fromNotchWindow,
          'terminal:resize': fromNotchWindow,
        },
        handlers: {
          'app:get-info': () => ({ name: app.getName(), version: app.getVersion(), platform: process.platform }),
          'app:get-runtime': () => ({ isPackaged: app.isPackaged, shortcutRegistered: shortcut.current() !== null }),
          'app:open-control-center': () => {
            showControlCenter()
            return null
          },
          'app:hide-notch': () => {
            notch.dispatch({ type: 'user-visibility', hidden: true })
            return null
          },
          'settings:get': () => settings.get(),
          'settings:update': (patch) => updateSettings(patch),
          'notch:get-mode': () => notch.mode(),
          'notch:request': ({ intent }) => {
            notch.dispatch({ type: intent })
            return null
          },
          'notch:pointer': ({ inside }) => {
            notch.dispatch({ type: 'pointer', inside })
            return null
          },
          'notch:settled': () => {
            notch.settled()
            return null
          },
          'notch:open-integration': ({ id }) => {
            notch.dispatch({ type: 'open-integration', id })
            return null
          },
          'notch:back': () => {
            notch.dispatch({ type: 'back' })
            return null
          },
          'terminal:open': () => terminal.open(),
          'terminal:input': ({ data }) => {
            terminal.write(data)
            return null
          },
          'terminal:resize': ({ cols, rows }) => {
            terminal.resize(cols, rows)
            return null
          },
        },
      })

      app.on('will-quit', () => {
        watcher?.stop()
        notch.dispose()
        shortcut.dispose()
        tray?.destroy()
        screen.off('display-added', onDisplaysChanged)
        screen.off('display-removed', onDisplaysChanged)
        screen.off('display-metrics-changed', onDisplaysChanged)
      })

      logger.info('Developer Notch started', {
        version: app.getVersion(),
        foregroundWatch: watcher ? 'on' : 'off',
        shortcut: shortcut.current(),
      })
    })
    .catch((error: unknown) => {
      logger.error('Startup failed', { error })
      app.quit()
    })
}
