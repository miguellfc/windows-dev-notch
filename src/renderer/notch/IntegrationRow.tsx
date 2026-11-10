import { SquareTerminal, type LucideIcon } from 'lucide-react'
import { integrations, type IntegrationId } from '../../shared/integrations/registry'
import { useT } from '../shared/use-t'

const icons: Readonly<Record<IntegrationId, LucideIcon>> = {
  terminal: SquareTerminal,
}

/** One tile per live integration; clicking opens its mini tool inside the notch. */
export function IntegrationRow() {
  const t = useT()
  return (
    <section aria-label={t('notch.integrations.label')} className="flex shrink-0 gap-2 px-1">
      {integrations.map(({ id, labelKey }) => {
        const Icon = icons[id]
        return (
          <button
            key={id}
            type="button"
            data-testid={`integration-${id}`}
            onClick={() => void window.notch.notch.openIntegration({ id })}
            className="flex h-[60px] w-[72px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-tile border border-line bg-veil-tile text-chalk transition-colors duration-150 hover:bg-[rgba(255,255,255,0.09)]"
          >
            <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
            <span className="text-label font-medium">{t(labelKey)}</span>
          </button>
        )
      })}
    </section>
  )
}
