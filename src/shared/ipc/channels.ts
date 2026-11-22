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
    capsuleRect: 'notch:capsule-rect',
  },
  apps: {
    open: 'apps:open',
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
    getQuestions: 'claude:get-questions',
    answer: 'claude:answer',
    releaseQuestion: 'claude:release-question',
    accounts: 'claude:accounts',
    accountAdd: 'claude:account-add',
  },
  reminders: {
    list: 'reminders:list',
    create: 'reminders:create',
    update: 'reminders:update',
    snooze: 'reminders:snooze',
    complete: 'reminders:complete',
    delete: 'reminders:delete',
  },
  notes: {
    list: 'notes:list',
    create: 'notes:create',
    update: 'notes:update',
    pin: 'notes:pin',
    delete: 'notes:delete',
    restore: 'notes:restore',
    copy: 'notes:copy',
  },
  usage: {
    summary: 'usage:summary',
  },
  gmail: {
    getState: 'gmail:get-state',
    recent: 'gmail:recent',
    view: 'gmail:view',
    refresh: 'gmail:refresh',
    open: 'gmail:open',
    signIn: 'gmail:sign-in',
    cancelSignIn: 'gmail:cancel-sign-in',
    signOut: 'gmail:sign-out',
    pickClientFile: 'gmail:pick-client-file',
    message: 'gmail:message',
    markRead: 'gmail:mark-read',
    delete: 'gmail:delete',
    openLink: 'gmail:open-link',
    closeMessage: 'gmail:close-message',
  },
  codeReview: {
    getState: 'code-review:get-state',
    refresh: 'code-review:refresh',
    openProfile: 'code-review:open-profile',
    openAlert: 'code-review:open-alert',
    setToken: 'code-review:set-token',
    clear: 'code-review:clear',
    view: 'code-review:view',
    contributions: 'code-review:contributions',
  },
  redmine: {
    getState: 'redmine:get-state',
    issues: 'redmine:issues',
    issue: 'redmine:issue',
    findIssue: 'redmine:find-issue',
    activities: 'redmine:activities',
    updateIssue: 'redmine:update-issue',
    logTime: 'redmine:log-time',
    summary: 'redmine:summary',
    view: 'redmine:view',
    refresh: 'redmine:refresh',
    open: 'redmine:open',
    setKey: 'redmine:set-key',
    clear: 'redmine:clear',
  },
  workLog: {
    list: 'work-log:list',
    setInvoiced: 'work-log:set-invoiced',
    delete: 'work-log:delete',
    restore: 'work-log:restore',
    copy: 'work-log:copy',
    summarize: 'work-log:summarize',
    claudeAvailable: 'work-log:claude-available',
  },
} as const

/** Events the main process pushes to renderers. */
export const eventChannels = {
  notchModeChanged: 'notch:mode-changed',
  notchMailAlert: 'notch:mail-alert',
  notchReviewAlert: 'notch:review-alert',
  notchRedmineAlert: 'notch:redmine-alert',
  settingsChanged: 'settings:changed',
  claudeStateChanged: 'claude:state-changed',
  claudeQuestions: 'claude:questions',
  remindersChanged: 'reminders:changed',
  remindersFired: 'reminders:fired',
  notesChanged: 'notes:changed',
  systemMetrics: 'system:metrics',
  gmailState: 'gmail:state',
  gmailNewMail: 'gmail:new-mail',
  codeReviewState: 'code-review:state',
  codeReviewAlert: 'code-review:alert',
  codeReviewContributionsChanged: 'code-review:contributions-changed',
  redmineState: 'redmine:state',
  redmineSummaryChanged: 'redmine:summary-changed',
  redmineAlert: 'redmine:alert',
  workLogChanged: 'work-log:changed',
} as const

type ChannelGroups = typeof channels
export type ChannelName = {
  [Group in keyof ChannelGroups]: ChannelGroups[Group][keyof ChannelGroups[Group]]
}[keyof ChannelGroups]

export type EventName = (typeof eventChannels)[keyof typeof eventChannels]
