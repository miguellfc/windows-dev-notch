import { homedir } from 'node:os'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, nativeTheme, net, safeStorage, screen, session, shell, type Display } from 'electron'
import type { ControlCenterPage } from '../shared/ipc/contract'
import { DEV_CSP } from '../shared/security/csp'
import { createDefaultSettings, type Settings } from '../shared/settings/schema'
import { createClaudeIntegration } from './claude/claude-integration'
import { claudeChannelGuards } from './claude/claude-ipc'
import { createCodeReviewIntegration, parseCodeReviewBaseOverrides } from './code-review/code-review-integration'
import { codeReviewChannelGuards, createCodeReviewIpcHandlers } from './code-review/code-review-ipc'
import { createGithubClient } from './code-review/github-client'
import { createGitlabClient } from './code-review/gitlab-client'
import { createGmailAuth, GOOGLE_OAUTH_BASE } from './gmail/gmail-auth'
import { createGmailClient, GMAIL_API_BASE } from './gmail/gmail-client'
import { createGmailIntegration, parseGmailBaseOverride, type GmailIntegration } from './gmail/gmail-integration'
import { createClientFilePicker } from './gmail/client-file'
import { createGmailIpcHandlers, gmailChannelGuards } from './gmail/gmail-ipc'
import { createTokenStore } from './gmail/token-store'
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
import { createSecureTokenStore } from './services/secure-token-store'
import { SettingsStore } from './services/settings-store'
import { createSettingsUpdater } from './services/settings-update'
import { createUsageIpcHandlers, usageChannelGuards } from './services/usage-ipc'
import { createQuitFlush } from './services/quit-flush'
import { createTestClockTimers } from './services/test-clock-timers'
import { createUsageLog } from './services/usage-log'
import { createNotesIntegration } from './notes/notes-integration'
import { notesChannelGuards } from './notes/notes-ipc'
import { createRemindersIntegration } from './reminders/reminders-integration'
import { remindersChannelGuards } from './reminders/reminders-ipc'
import { createSystemIntegration } from './system/system-integration'
import { systemChannelGuards } from './system/system-ipc'
import { pathExists, resolveShell, shellEnvironment } from './terminal/shell-resolver'
import { createTerminalSession } from './terminal/terminal-session'
import { controlCenterWindow, openControlCenter } from './windows/control-center-window'
import { createNotchController } from './windows/notch-controller'
import { createNotchWindow, nativeHandle } from './windows/notch-window'
import { denyAllPermissions, hardenWebContents } from './windows/secure-window'

const APP_USER_MODEL_ID = 'dev.developernotch.app'
const USAGE_TICK_MS = 60_000
/** Upper bound on the quit flush (usage counts, in-flight note writes), so quitting never hangs on the disk. */
const USAGE_QUIT_FLUSH_MS = 2_000

// Development-only switches. A packaged build ignores them all, so nothing in the
// environment can point the installed app at another page, profile or behaviour.
const devServerUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL']
const isolatedUserData = app.isPackaged ? undefined : process.env['NOTCH_USER_DATA_DIR']
const foregroundWatchDisabled = !app.isPackaged && process.env['NOTCH_DISABLE_FOREGROUND_WATCH'] === '1'
// E2E: "Answer in Claude" / "Go to session" must not bring the real Claude window forward.
const claudeFocusDisabled = !app.isPackaged && process.env['NOTCH_DISABLE_CLAUDE_FOCUS'] === '1'
const claudeSettingsOverride = app.isPackaged ? undefined : process.env['NOTCH_CLAUDE_SETTINGS']
const claudePortRaw = app.isPackaged ? undefined : process.env['NOTCH_CLAUDE_PORT']
const claudePortOverride =
  claudePortRaw !== undefined && /^\d{1,5}$/.test(claudePortRaw) && Number(claudePortRaw) <= 65_535 ? Number(claudePortRaw) : undefined
const testClockEnabled = !app.isPackaged && process.env['NOTCH_TEST_CLOCK'] === '1'
// One fake server for E2E: replaces the Gmail API and the OAuth token/revoke/consent origins.
// Only an exact http://127.0.0.1:<port> origin is accepted.
const gmailBaseOverride = parseGmailBaseOverride(app.isPackaged ? undefined : process.env['NOTCH_GMAIL_BASE_URL'])
// Fake GitHub/GitLab servers for E2E (`github=http://127.0.0.1:<port>,gitlab=http://127.0.0.1:<port>`).
// Only exact loopback http origins with a port; anything malformed turns the whole switch off.
const codeReviewBaseOverrides = parseCodeReviewBaseOverrides(app.isPackaged ? undefined : process.env['NOTCH_CODE_REVIEW_BASE_URLS'])
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
  // Obsidian is dark-only (DESIGN.md). Mica, the title-bar buttons and native menus follow this
  // instead of the Windows app theme, so a light system theme never puts Tiza text on light Mica.
  nativeTheme.themeSource = 'dark'

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

      // --- Usage log -------------------------------------------------------------------
      // Daily counts kept only on this PC (userData/usage.json) for the About page. Loading does
      // not block startup; events recorded meanwhile are merged into the file's.
      const usage = createUsageLog({ file: join(app.getPath('userData'), 'usage.json'), logger, now: () => new Date() })
      const usageLoaded = usage.load()
      usage.record({ type: 'launch' })
      const usageTimer = setInterval(() => usage.tick(), USAGE_TICK_MS)

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
      // System monitor: samples by notch mode; events go to the notch only. Started after registerIpc.
      const system = createSystemIntegration({
        logger,
        mode: () => notch.mode(),
        alertSettings: () => settings.get().systemAlerts,
        notchTarget: () => (notchWindow.isDestroyed() ? null : notchWindow.webContents),
      })
      notchWindow.webContents.on('did-finish-load', () => system.resync())
      // Gmail polls in every notch mode (its alerts show over mini and hidden); created further down.
      let gmail: GmailIntegration | null = null
      const notch = createNotchController({
        surface,
        workArea: display.workArea,
        logger,
        onModeChange: (mode) => {
          tray?.refresh()
          // Metrics pause in mini, hidden and alert (an alert over a hidden capsule included); the light
          // rhythm keeps running in peek so hovering into compact shows current values at once.
          system.setMode(mode)
        },
        // An alert over a hidden capsule keeps the mode `alert`: the tray's Show/Hide follows this instead.
        onHiddenChange: () => tray?.refresh(),
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
      const showControlCenter = (page?: ControlCenterPage) => {
        notch.dispatch({ type: 'dismiss' })
        openControlCenter({
          preloadPath,
          devServerUrl,
          rendererFile: rendererFile('control-center'),
          devTools: !app.isPackaged,
          onLoadFailed,
          onPageFailed: (error) => logger.warn('Control Center could not switch page', { error }),
          ...(page ? { page } : {}),
        })
      }

      tray = createAppTray(
        () => ({
          language: settings.get().language,
          notchVisible: !notch.hidden(),
          launchAtLogin: settings.get().launchAtLogin,
          launchAtLoginAvailable: app.isPackaged,
          actions: {
            // "Show" must always show, even while a fullscreen app made the capsule yield (or an alert
            // shows over the hidden capsule).
            toggleVisibility: () =>
              notch.dispatch(notch.hidden() ? { type: 'show' } : { type: 'user-visibility', hidden: true }),
            openControlCenter: () => showControlCenter(),
            setLaunchAtLogin: (enabled) => {
              updateSettings({ launchAtLogin: enabled }).catch((error: unknown) =>
                logger.error('Could not change start with Windows', { error }),
              )
            },
            quit: () => app.quit(),
          },
        }),
        // The tray icon shows the notch like its "Show" item (un-hides even from an alert).
        () => notch.dispatch({ type: 'show' }),
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
      // The Control Center may not exist yet; then nothing matches.
      const fromControlCenter = (event: IpcEventLike) => event.sender.id === controlCenterWindow()?.webContents.id
      // Windows that receive integration events: the notch, and the Control Center when open.
      const notchAndControlCenter = () => {
        const cc = controlCenterWindow()
        const targets = notchWindow.isDestroyed() ? [] : [notchWindow.webContents]
        return cc ? [...targets, cc.webContents] : targets
      }

      // --- Claude Code -----------------------------------------------------------------
      // Local bridge for Claude Code hooks. If it cannot start (port taken, no safeStorage),
      // the state says so and the rest of the app keeps working.
      const claude = createClaudeIntegration({
        userDataDir: app.getPath('userData'),
        claudeSettingsFile: claudeSettingsOverride ?? join(homedir(), '.claude', 'settings.json'),
        ...(claudePortOverride === undefined ? {} : { claudePort: claudePortOverride }),
        ...(claudeFocusDisabled ? { focusDisabled: true } : {}),
        logger,
        notch,
        language: () => settings.get().language,
        eventTargets: notchAndControlCenter,
        notchTarget: () => (notchWindow.isDestroyed() ? null : notchWindow.webContents),
        onAlert: (latencyMs) => usage.record({ type: 'claude-alert', latencyMs }),
      })
      claude.start().catch((error: unknown) => logger.error('Claude integration failed to start', { error }))

      // --- Reminders -------------------------------------------------------------------
      // Dev/test only: E2E moves this clock forward instead of waiting for real time.
      let clockOffsetMs = 0
      const reminders = createRemindersIntegration({
        userDataDir: app.getPath('userData'),
        logger,
        notch,
        language: () => settings.get().language,
        snoozeMinutes: () => settings.get().reminders.snoozeMinutes,
        now: testClockEnabled ? () => new Date(Date.now() + clockOffsetMs) : () => new Date(),
        notchTarget: () => (notchWindow.isDestroyed() ? null : notchWindow.webContents),
        eventTargets: notchAndControlCenter,
        recordUsage: (event) => usage.record(event),
      })
      const testNow = () => Date.now() + clockOffsetMs
      // Gmail's 60 s poll follows the same test clock (its timers also fire in real time).
      const gmailTestTimers = testClockEnabled ? createTestClockTimers(testNow) : null
      // So does the 120 s GitHub/GitLab rhythm (and its backoff).
      const codeReviewTestTimers = testClockEnabled ? createTestClockTimers(testNow) : null
      if (testClockEnabled) {
        globalThis.__notchTestClock = {
          advance: (ms) => {
            clockOffsetMs += ms
            gmailTestTimers?.fireDue()
            codeReviewTestTimers?.fireDue()
            return reminders.check()
          },
        }
      }
      // --- Notes -----------------------------------------------------------------------
      const notes = createNotesIntegration({
        userDataDir: app.getPath('userData'),
        logger,
        now: () => new Date(),
        notchTarget: () => (notchWindow.isDestroyed() ? null : notchWindow.webContents),
        writeClipboard: (text) => clipboard.writeText(text),
      })
      // --- Gmail -----------------------------------------------------------------------
      // Read-only Gmail (Primary): the refresh token stays in main, encrypted with safeStorage.
      // Loading the token is async and never blocks registerIpc; gmail:* calls wait for it.
      const gmailOauthBase = gmailBaseOverride ?? GOOGLE_OAUTH_BASE
      // Electron's network stack, so the system proxy applies to Gmail and OAuth requests.
      const gmailFetch = (url: string, init?: RequestInit) => net.fetch(url, init)
      gmail = createGmailIntegration({
        settings,
        tokenStore: createTokenStore({ file: join(app.getPath('userData'), 'gmail-token.bin'), safeStorage, logger }),
        authFactory: ({ clientId, clientSecret }) =>
          createGmailAuth({
            fetch: gmailFetch,
            openExternal: (url) => shell.openExternal(url),
            oauthBase: gmailOauthBase,
            clientId,
            clientSecret,
            ...(gmailBaseOverride === undefined ? {} : { authUrl: `${gmailBaseOverride}/o/oauth2/v2/auth` }),
          }),
        clientFactory: (access) => createGmailClient({ fetch: gmailFetch, apiBase: gmailBaseOverride ?? GMAIL_API_BASE, ...access }),
        timers: gmailTestTimers ?? { setTimeout, clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
        now: gmailTestTimers ? testNow : () => Date.now(),
        emit: (state) => emitEvent(notchAndControlCenter(), 'gmail:state', state, logger),
        openExternal: (url) => shell.openExternal(url),
        // New mail goes to the notch only (the alert lives there; the Control Center has no use for it).
        // The payload goes first, so the capsule already knows what to show when the mode turns to alert;
        // the controller drops the alert with a panel open and ends it after 6 s.
        onNewMail: (mail) => {
          if (notchWindow.isDestroyed()) return
          emitEvent([notchWindow.webContents], 'gmail:new-mail', mail, logger)
          notch.dispatch({ type: 'mail', on: true })
        },
        logger,
      })
      gmail.start()
      // --- GitHub & GitLab ---------------------------------------------------------------
      // Read-only PR/MR status with personal tokens kept in main, encrypted with safeStorage (one file
      // per platform). Loading them is async and never blocks registerIpc; code-review:* calls wait.
      const codeReviewFetch = (url: string, init?: RequestInit) => net.fetch(url, init)
      const codeReviewTokenStore = (file: string) =>
        createSecureTokenStore({ file: join(app.getPath('userData'), file), safeStorage, logger, logScope: 'code-review-token' })
      const githubApiOverride = codeReviewBaseOverrides.github
      const gitlabApiOverride = codeReviewBaseOverrides.gitlab
      const codeReview = createCodeReviewIntegration({
        settings: {
          get: () => settings.get(),
          onChange: (listener) => settings.onChange(listener),
          // Through the updater, like every other settings change (validation, settings:changed).
          update: (patch) => updateSettings(patch),
        },
        tokenStores: {
          github: codeReviewTokenStore('code-review-github.bin'),
          gitlab: codeReviewTokenStore('code-review-gitlab.bin'),
        },
        clientFactories: {
          github: (token) =>
            createGithubClient({ fetch: codeReviewFetch, token, ...(githubApiOverride === undefined ? {} : { apiBase: githubApiOverride }) }),
          // Settings only ever hold an https server; in dev/E2E the fake on 127.0.0.1 stands in for it.
          gitlab: (baseUrl, token) =>
            createGitlabClient({
              fetch: codeReviewFetch,
              token,
              ...(gitlabApiOverride === undefined ? { baseUrl } : { baseUrl: gitlabApiOverride, allowLoopbackHttp: true }),
            }),
        },
        timers: codeReviewTestTimers ?? { setTimeout, clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
        now: codeReviewTestTimers ? testNow : () => Date.now(),
        emit: (state) => emitEvent(notchAndControlCenter(), 'code-review:state', state, logger),
        // Contributions are shown only in the notch's "Revisiones" view.
        emitContributions: (change) => {
          if (notchWindow.isDestroyed()) return
          emitEvent([notchWindow.webContents], 'code-review:contributions-changed', change, logger)
        },
        openExternal: (url) => shell.openExternal(url),
        // First reviews go to the notch only, payload first (like new mail): the capsule already knows
        // what to show when the mode turns to alert; the controller drops it with a panel open and
        // ends it after 6 s.
        onAlert: (alert) => {
          if (notchWindow.isDestroyed()) return
          emitEvent([notchWindow.webContents], 'code-review:alert', alert, logger)
          notch.dispatch({ type: 'review', on: true })
        },
        logger,
      })
      // A (re)loaded notch starts with every view closed: no contributions polling and no open Gmail
      // message are left behind for a view that no longer exists.
      notchWindow.webContents.on('did-finish-load', () => {
        codeReview.setViewOpen(false)
        gmail?.setViewOpen(false)
      })
      // --- IPC -----------------------------------------------------------------------
      registerIpc({
        ipcMain,
        logger,
        isTrustedUrl: createSenderGuard({ rendererDir: join(__dirname, '../renderer'), devServerUrl }),
        channelGuards: {
          'terminal:open': fromNotchWindow,
          'terminal:input': fromNotchWindow,
          'terminal:resize': fromNotchWindow,
          ...claudeChannelGuards({ fromNotch: fromNotchWindow, fromControlCenter }),
          ...remindersChannelGuards({ fromNotch: fromNotchWindow, fromControlCenter }),
          ...usageChannelGuards({ fromControlCenter }),
          ...systemChannelGuards({ fromNotch: fromNotchWindow }),
          ...notesChannelGuards({ fromNotch: fromNotchWindow }),
          ...gmailChannelGuards({ fromNotch: fromNotchWindow, fromControlCenter }),
          ...codeReviewChannelGuards({ fromNotch: fromNotchWindow, fromControlCenter }),
        },
        handlers: {
          'app:get-info': () => ({ name: app.getName(), version: app.getVersion(), platform: process.platform }),
          'app:get-runtime': () => ({ isPackaged: app.isPackaged, shortcutRegistered: shortcut.current() !== null }),
          'app:open-control-center': (input) => {
            showControlCenter(input?.page)
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
          ...claude.handlers,
          ...reminders.handlers,
          ...notes.handlers,
          ...createUsageIpcHandlers(usage, () => usageLoaded),
          ...system.handlers,
          ...createGmailIpcHandlers(
            gmail,
            createClientFilePicker({
              showOpenDialog: (options) => {
                const parent = controlCenterWindow()
                return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options)
              },
              stat: (path) => stat(path),
              readFile: (path) => readFile(path, 'utf8'),
            }),
          ),
          ...createCodeReviewIpcHandlers(codeReview),
        },
      })
      // Non-blocking: the rhythm starts now; the first queries run once the stored tokens are read.
      codeReview.start()

      // Started after registerIpc so the renderers never miss a handler; reminders:* calls wait
      // for this to finish, so the first list already reflects the file.
      reminders.start().catch((error: unknown) => logger.error('Reminders failed to start', { error }))
      notes.start().catch((error: unknown) => logger.error('Notes failed to start', { error }))
      system.start().catch((error: unknown) => logger.error('System monitor failed to start', { error }))

      app.on(
        'will-quit',
        createQuitFlush({
          // First pass: save the usage counts and let any in-flight note write finish (async),
          // then quit again to run the cleanup below.
          flush: () => Promise.all([usage.flush(), notes.flush()]).then(() => undefined),
          timeoutMs: USAGE_QUIT_FLUSH_MS,
          quit: () => app.quit(),
          onFlushStart: () => clearInterval(usageTimer),
          cleanup: () => {
            watcher?.stop()
            notch.dispose()
            // After the notch: releasing held requests must not drive a closing window.
            claude.dispose()
            reminders.dispose()
            system.dispose()
            gmail?.dispose()
            codeReview.dispose()
            shortcut.dispose()
            tray?.destroy()
            screen.off('display-added', onDisplaysChanged)
            screen.off('display-removed', onDisplaysChanged)
            screen.off('display-metrics-changed', onDisplaysChanged)
          },
        }),
      )

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
