import type { MessageKey } from '../i18n/messages'

/** Integrations that open as a mini tool inside the notch. */
export const viewIntegrationIds = ['reminders', 'system', 'notes', 'gmail', 'reviews'] as const

/** Views only: the id `notch:open-integration` and the notch state work with. */
export type IntegrationId = (typeof viewIntegrationIds)[number]

/** Tiles that launch a real app outside the notch (`apps:open`). Same ids as the main launcher's `AppId`. */
export const appIds = ['terminal', 'claude'] as const

export type AppTileId = (typeof appIds)[number]

export type Tile =
  | { readonly kind: 'view'; readonly id: IntegrationId; readonly labelKey: MessageKey }
  | { readonly kind: 'app'; readonly id: AppTileId; readonly labelKey: MessageKey }

/** The order of this list is the order of the tiles in the panel. Adding a tool starts here. */
export const tiles: readonly Tile[] = [
  { kind: 'app', id: 'terminal', labelKey: 'integration.terminal' },
  { kind: 'view', id: 'reminders', labelKey: 'integration.reminders' },
  { kind: 'view', id: 'system', labelKey: 'integration.system' },
  { kind: 'view', id: 'notes', labelKey: 'integration.notes' },
  { kind: 'view', id: 'gmail', labelKey: 'integration.gmail' },
  { kind: 'view', id: 'reviews', labelKey: 'integration.reviews' },
  { kind: 'app', id: 'claude', labelKey: 'integration.claude' },
]
