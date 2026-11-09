import type { MessageKey } from '../i18n/messages'

/** Live integrations shown as icons in the expanded panel. Adding a tool starts here. */
export const integrationIds = ['terminal'] as const

export type IntegrationId = (typeof integrationIds)[number]

export interface Integration {
  readonly id: IntegrationId
  readonly labelKey: MessageKey
}

/** The order of this list is the order of the icons in the panel. */
export const integrations: readonly Integration[] = [{ id: 'terminal', labelKey: 'integration.terminal' }]
