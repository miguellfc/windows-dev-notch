import type { MessageKey } from '../i18n/messages'

/** Integrations that open as a mini tool inside the notch. */
export const viewIntegrationIds = ['reminders', 'system', 'notes', 'gmail', 'reviews'] as const

/** The mini tools `notch:open-integration` opens. `reviews` has no tile of its own: the GitHub and GitLab tiles open it. */
export type IntegrationId = (typeof viewIntegrationIds)[number]

/** Tiles that launch a real app outside the notch (`apps:open`). Same ids as the main launcher's `AppId`. */
export const appIds = ['terminal', 'claude'] as const

export type AppTileId = (typeof appIds)[number]

/** Platforms whose tile opens the reviews view (`notch:open-integration` with id `reviews`). */
export const reviewPlatformIds = ['github', 'gitlab'] as const

export type ReviewTileId = (typeof reviewPlatformIds)[number]

export type Tile =
  | { readonly kind: 'view'; readonly id: Exclude<IntegrationId, 'reviews'>; readonly labelKey: MessageKey }
  | { readonly kind: 'app'; readonly id: AppTileId; readonly labelKey: MessageKey }
  | { readonly kind: 'review'; readonly id: ReviewTileId; readonly labelKey: MessageKey }

/** The order of this list is the order of the tiles in the panel. Adding a tool starts here. */
export const tiles: readonly Tile[] = [
  { kind: 'app', id: 'terminal', labelKey: 'integration.terminal' },
  { kind: 'view', id: 'reminders', labelKey: 'integration.reminders' },
  { kind: 'view', id: 'system', labelKey: 'integration.system' },
  { kind: 'view', id: 'notes', labelKey: 'integration.notes' },
  { kind: 'view', id: 'gmail', labelKey: 'integration.gmail' },
  { kind: 'review', id: 'github', labelKey: 'integration.github' },
  { kind: 'review', id: 'gitlab', labelKey: 'integration.gitlab' },
  { kind: 'app', id: 'claude', labelKey: 'integration.claude' },
]
