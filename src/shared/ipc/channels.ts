/**
 * Channel names exposed to the renderer, grouped by namespace.
 * Kept free of runtime dependencies so the sandboxed preload stays tiny.
 */
export const channels = {
  app: {
    getInfo: 'app:get-info',
    getRuntime: 'app:get-runtime',
    openControlCenter: 'app:open-control-center',
    hideNotch: 'app:hide-notch',
  },
  settings: {
    get: 'settings:get',
    update: 'settings:update',
  },
  notch: {
    getMode: 'notch:get-mode',
    request: 'notch:request',
    pointer: 'notch:pointer',
    settled: 'notch:settled',
    openIntegration: 'notch:open-integration',
    back: 'notch:back',
  },
  terminal: {
    open: 'terminal:open',
    input: 'terminal:input',
    resize: 'terminal:resize',
  },
  claude: {
    getState: 'claude:get-state',
    decide: 'claude:decide',
    focusApp: 'claude:focus-app',
    dismissSession: 'claude:dismiss-session',
    hooksPreview: 'claude:hooks-preview',
    hooksInstall: 'claude:hooks-install',
    hooksUninstall: 'claude:hooks-uninstall',
    testConnection: 'claude:test-connection',
    rotateToken: 'claude:rotate-token',
    rotatePort: 'claude:rotate-port',
  },
  reminders: {
    list: 'reminders:list',
    create: 'reminders:create',
    update: 'reminders:update',
    snooze: 'reminders:snooze',
    complete: 'reminders:complete',
    delete: 'reminders:delete',
  },
  usage: {
    summary: 'usage:summary',
  },
  system: {
    view: 'system:view',
    killProcess: 'system:kill-process',
  },
} as const

/** Events the main process pushes to renderers. */
export const eventChannels = {
  notchModeChanged: 'notch:mode-changed',
  settingsChanged: 'settings:changed',
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',
  claudeStateChanged: 'claude:state-changed',
  remindersChanged: 'reminders:changed',
  remindersFired: 'reminders:fired',
  systemMetrics: 'system:metrics',
  systemProcesses: 'system:processes',
} as const

type ChannelGroups = typeof channels
export type ChannelName = {
  [Group in keyof ChannelGroups]: ChannelGroups[Group][keyof ChannelGroups[Group]]
}[keyof ChannelGroups]

export type EventName = (typeof eventChannels)[keyof typeof eventChannels]
