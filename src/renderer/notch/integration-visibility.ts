import type { CapsuleIntegrationKey, IntegrationKey } from '../../shared/integrations/colors'
import type { Tile } from '../../shared/integrations/registry'
import type { NotchView } from '../../shared/notch/state'
import type { IntegrationsSettings } from '../../shared/settings/schema'

/** The integration a tile belongs to; Terminal belongs to none and always shows. */
function tileKey(tile: Tile): IntegrationKey | null {
  return tile.id === 'terminal' ? null : tile.id
}

/** The tiles of the enabled integrations, in registry order. */
export function visibleTiles(tiles: readonly Tile[], integrations: IntegrationsSettings): Tile[] {
  return tiles.filter((tile) => {
    const key = tileKey(tile)
    return key === null || integrations[key].enabled
  })
}

/** Whether an integration's block shows in the capsule. System's metrics never depend on this. */
export function capsuleShows(key: CapsuleIntegrationKey, integrations: IntegrationsSettings): boolean {
  const integration = integrations[key]
  return integration.enabled && integration.capsule
}

/** Whether a view may stay open. `reviews` lives while one of its platforms is on; Claude items follow Claude. */
export function viewAllowed(view: NotchView, integrations: IntegrationsSettings): boolean {
  if (view === 'home') return true
  if (view === 'reviews') return integrations.github.enabled || integrations.gitlab.enabled
  if (view === 'permission' || view === 'question') return integrations.claude.enabled
  return integrations[view].enabled
}

export type AlertKind = 'mail' | 'review-github' | 'review-gitlab' | 'redmine' | 'reminder' | 'claude'

const alertKeys: Readonly<Record<AlertKind, IntegrationKey>> = {
  mail: 'gmail',
  'review-github': 'github',
  'review-gitlab': 'gitlab',
  redmine: 'redmine',
  reminder: 'reminders',
  claude: 'claude',
}

/** Whether an alert (and its chime) may show. */
export function alertAllowed(kind: AlertKind, integrations: IntegrationsSettings): boolean {
  return integrations[alertKeys[kind]].enabled
}
