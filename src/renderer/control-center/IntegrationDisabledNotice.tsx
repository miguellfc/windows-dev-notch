import { createContext, useContext } from 'react'
import type { IntegrationKey } from '../../shared/integrations/colors'
import { useIntegration } from '../shared/integration-color'
import { useT } from '../shared/use-t'

/** Opens the Integrations page; ControlCenterApp provides it. */
export const OpenIntegrationsContext = createContext<() => void>(() => undefined)

/**
 * «Desactivada · Activar en Integraciones» at the top of an integration's page while it is off. The
 * optional prefix names the platform where one page covers two (GitHub and GitLab).
 */
export function IntegrationDisabledNotice({ integration, prefix }: { integration: IntegrationKey; prefix?: string }) {
  const t = useT()
  const openIntegrations = useContext(OpenIntegrationsContext)
  const { enabled } = useIntegration(integration)
  if (enabled) return null
  return (
    <p data-testid={`integration-disabled-${integration}`} className="mb-4 text-small text-graphite">
      {prefix ? `${prefix}: ` : null}
      <button
        type="button"
        onClick={openIntegrations}
        className="cursor-pointer text-chalk underline decoration-line underline-offset-2 hover:decoration-chalk"
      >
        {t('cc.integrations.disabledNotice')}
      </button>
    </p>
  )
}
