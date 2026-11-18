import type { IntegrationKey } from '../../shared/integrations/colors'
import { cloneDefaultIntegrations, type IntegrationSettings } from '../../shared/settings/schema'
import { useSettings } from './settings-store'

export { integrationStyle } from './integration-style'

const defaults = cloneDefaultIntegrations()

/** One integration's settings; the defaults until settings have loaded. */
export function useIntegration(key: IntegrationKey): IntegrationSettings {
  return useSettings((state) => state.settings?.integrations[key] ?? defaults[key])
}
