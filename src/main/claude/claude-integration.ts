import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Notification, safeStorage } from 'electron'
import { translate } from '../../shared/i18n/messages'
import { PANEL_MODES } from '../../shared/notch/state'
import type { Language } from '../../shared/settings/schema'
import { emitEvent, type EventTarget } from '../ipc/events'
import type { Logger } from '../services/logger'
import type { NotchController } from '../windows/notch-controller'
import { loadBridgeConfig, randomDynamicPort, rotatePort, rotateToken, type BridgeConfigDeps } from './bridge-config'
import { bringClaudeToFront, createWin32FocusApi, type Win32FocusApi } from './bring-claude-to-front'
import { createClaudeBridge } from './claude-bridge'
import { createClaudeIpcHandlers } from './claude-ipc'
import { createClaudeService } from './claude-service'
import { createHookInstaller } from './hook-installer'
import { readTextFile, writeFileAtomic } from '../services/fs-atomic'
import { createPermissionToast, type ToastRequest } from './toast'

const TICK_MS = 60_000

export interface ClaudeIntegrationOptions {
  userDataDir: string
  /** Claude Code's settings.json that holds our hooks. */
  claudeSettingsFile: string
  /** Dev/test only (never set in a packaged build): bridge port override, 0 = ephemeral. */
  claudePort?: number
  logger: Logger
  notch: NotchController
  language: () => Language
  /** Windows that receive `claude:state-changed` (notch, and the Control Center when open). */
  eventTargets: () => EventTarget[]
  /**
   * A new permission request reached the capsule: ms from the bridge receiving the HTTP request
   * (before its body is read) to the notch controller applying `attention`. Main-side only; the
   * renderer's paint is not included.
   */
  onAlert?: (latencyMs: number) => void
}

/** Electron adapter around the ClaudeService: real files, safeStorage, toasts and timers. */
export function createClaudeIntegration(options: ClaudeIntegrationOptions) {
  const { logger, notch } = options
  const log = logger.child('claude')

  const bridgeConfig: BridgeConfigDeps = {
    file: join(options.userDataDir, 'claude-bridge.json'),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (buf) => safeStorage.decryptString(buf),
    randomToken: () => randomBytes(32).toString('hex'),
    randomPort: randomDynamicPort,
  }

  // Electron drops click handlers of notifications that get garbage-collected.
  const liveToasts = new Set<Notification>()
  const notify = (request: ToastRequest) => {
    if (!Notification.isSupported()) return
    const toast = new Notification({ title: request.title, body: request.body })
    const forget = () => liveToasts.delete(toast)
    toast.on('click', () => {
      forget()
      request.onClick()
    })
    toast.on('close', forget)
    liveToasts.add(toast)
    toast.show()
  }
  const toast = createPermissionToast({ notify, translate: (key) => translate(options.language(), key) })

  let focusApi: Win32FocusApi | null | undefined
  const focusClaude = () => {
    focusApi ??= createWin32FocusApi(logger)
    if (!focusApi) return
    log.info('Bring Claude to front', { result: bringClaudeToFront(focusApi) })
  }

  const service = createClaudeService({
    logger,
    now: () => Date.now(),
    newId: () => randomUUID(),
    encryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    ...(options.claudePort === undefined ? {} : { portOverride: options.claudePort }),
    loadConfig: () => loadBridgeConfig(bridgeConfig),
    rotateConfig: () => rotateToken(bridgeConfig),
    rotatePortConfig: () => rotatePort(bridgeConfig),
    createBridge: (bridge) => createClaudeBridge({ ...bridge, logger }),
    installer: createHookInstaller({
      file: options.claudeSettingsFile,
      readFile: readTextFile,
      writeFileAtomic,
      backupDir: join(options.userDataDir, 'claude-hooks-backups'),
      now: () => new Date(),
    }),
    focusClaude,
    onState: (state) => {
      notch.dispatch({ type: 'attention', on: state.pending.length > 0 })
      emitEvent(options.eventTargets(), 'claude:state-changed', state, logger)
    },
    onNewPending: (permission) => {
      // Called after onState above has dispatched `attention` for this request.
      options.onAlert?.(Date.now() - permission.receivedAt)
      // The open panel already shows the request; otherwise tell the user even if the capsule is hidden.
      if (!PANEL_MODES.has(notch.mode())) toast.show(permission, () => notch.dispatch({ type: 'expand' }))
    },
  })

  let timer: ReturnType<typeof setInterval> | null = null

  return {
    handlers: createClaudeIpcHandlers(service),
    start: async () => {
      await service.start()
      timer = setInterval(() => {
        service.tick().catch((error: unknown) => log.error('Claude tick failed', { error }))
      }, TICK_MS)
    },
    /** Releases every held request (Claude falls back to its own prompt) and stops the bridge. */
    dispose: () => {
      if (timer) clearInterval(timer)
      timer = null
      service.stop().catch((error: unknown) => log.error('Claude bridge did not stop cleanly', { error }))
    },
  }
}
