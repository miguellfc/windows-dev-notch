/** Integrations that open as a mini tool inside the notch. */
export const viewIntegrationIds = ['reminders', 'notes', 'gmail', 'reviews', 'redmine', 'workLog'] as const

/** The mini tools `notch:open-integration` opens. `reviews` has no card of its own: the GitHub and GitLab cards open it. */
export type IntegrationId = (typeof viewIntegrationIds)[number]

/** Quick-access buttons that launch a real app outside the notch (`apps:open`). Same ids as the main launcher's `AppId`. */
export const appIds = ['terminal', 'claude'] as const

export type AppTileId = (typeof appIds)[number]
