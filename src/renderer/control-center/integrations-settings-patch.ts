import type { IntegrationKey } from '../../shared/integrations/colors'
import type { IntegrationSettings, IntegrationsSettings } from '../../shared/settings/schema'
import { createBlockUpdater } from './settings-block-patch'

export type IntegrationsPatch = Partial<Record<IntegrationKey, Partial<IntegrationSettings>>>

/**
 * Serialized patches of the integrations block (see `createBlockUpdater`). Each patch carries only
 * the changed fields of one integration: the store merges per key and field, so a recolor never
 * restores another integration's stale switch.
 */
export function createIntegrationsUpdater<R>(
  getLatest: () => IntegrationsSettings,
  update: (patch: { integrations: IntegrationsPatch }) => Promise<R>,
) {
  const run = createBlockUpdater<'integrations', IntegrationsPatch, R>('integrations', getLatest, update)
  return (key: IntegrationKey, fields: Partial<IntegrationSettings>): Promise<R> => run(() => ({ [key]: fields }))
}
