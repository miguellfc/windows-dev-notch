import { Activity, AlarmClock, StickyNote, type LucideIcon } from 'lucide-react'
import { capsuleIntegrationKeys, integrationKeys, type IntegrationKey } from '../../shared/integrations/colors'
import type { MessageKey } from '../../shared/i18n/messages'
import type { Settings } from '../../shared/settings/schema'
import { ClaudeMark, GithubMark, GitlabMark, GmailMark, RedmineMark } from '../shared/brand-icons'
import { integrationStyle } from '../shared/integration-color'
import { useSettings } from '../shared/settings-store'
import { useT } from '../shared/use-t'
import { ColorSwatchPicker } from '../ui/ColorSwatchPicker'
import { Switch } from '../ui/Switch'
import { createIntegrationsUpdater } from './integrations-settings-patch'

const ROWS: Readonly<Record<IntegrationKey, { label: MessageKey; icon: LucideIcon }>> = {
  claude: { label: 'integration.claudeCode', icon: ClaudeMark },
  github: { label: 'integration.github', icon: GithubMark },
  gitlab: { label: 'integration.gitlab', icon: GitlabMark },
  gmail: { label: 'integration.gmail', icon: GmailMark },
  redmine: { label: 'integration.redmine', icon: RedmineMark },
  reminders: { label: 'integration.reminders', icon: AlarmClock },
  notes: { label: 'integration.notes', icon: StickyNote },
  system: { label: 'integration.system', icon: Activity },
}

const capsuleKeys: ReadonlySet<IntegrationKey> = new Set(capsuleIntegrationKeys)

// Serialized per-key patches: a recolor right after a switch never sends a stale block.
const updateIntegration = createIntegrationsUpdater(
  () => useSettings.getState().settings!.integrations,
  (patch) => useSettings.getState().update(patch),
)

/** Every integration: on/off, capsule block (where it has one) and its palette color. */
export function IntegrationsPage({ settings }: { settings: Settings }) {
  const t = useT()
  const header = 'px-4 py-2 text-left text-caps font-medium uppercase text-graphite'
  return (
    <>
      <p className="mb-4 text-small text-graphite">{t('cc.integrations.intro')}</p>
      <section className="card overflow-hidden">
        <table className="w-full border-collapse" data-testid="integrations-table">
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className={header}>
                <span className="sr-only">{t('cc.integrations.title')}</span>
              </th>
              <th scope="col" className={header}>{t('cc.integrations.active')}</th>
              <th scope="col" className={header}>{t('cc.integrations.capsule')}</th>
              <th scope="col" className={header}>{t('cc.integrations.color')}</th>
            </tr>
          </thead>
          <tbody>
            {integrationKeys.map((key) => {
              const integration = settings.integrations[key]
              const { label: labelKey, icon: Icon } = ROWS[key]
              const name = t(labelKey)
              return (
                <tr key={key} data-testid={`integration-row-${key}`} className="border-b border-line align-top last:border-b-0">
                  <th scope="row" className="px-4 py-3 text-left font-normal">
                    <span className="flex h-8 items-center gap-2 text-body text-chalk" style={integrationStyle(integration.color)}>
                      <Icon size={16} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-[color:var(--int)]" />
                      {name}
                    </span>
                  </th>
                  <td className="px-4 py-3">
                    <span className="flex h-8 items-center">
                      <Switch
                        checked={integration.enabled}
                        label={`${name}: ${t('cc.integrations.active')}`}
                        onChange={(enabled) => void updateIntegration(key, { enabled })}
                      />
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="flex h-8 items-center">
                      {capsuleKeys.has(key) ? (
                        <Switch
                          checked={integration.capsule}
                          disabled={!integration.enabled}
                          label={`${name}: ${t('cc.integrations.capsule')}`}
                          onChange={(capsule) => void updateIntegration(key, { capsule })}
                        />
                      ) : key === 'system' ? (
                        <span className="text-small text-graphite">{t('cc.integrations.always')}</span>
                      ) : null}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <ColorSwatchPicker
                      value={integration.color}
                      label={`${name}: ${t('cc.integrations.color')}`}
                      onChange={(color) => void updateIntegration(key, { color })}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>
    </>
  )
}
