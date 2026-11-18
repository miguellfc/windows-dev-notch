import type { MouseEvent } from 'react'
import { translate } from '../../../shared/i18n/messages'
import type { RedmineAlert as RedmineAlertPayload } from '../../../shared/redmine/schema'
import { RedmineMark } from '../../shared/brand-icons'
import { locale } from '../../shared/locale'
import { useLanguage } from '../../shared/use-t'
import { integrationStyle, useIntegration } from '../../shared/integration-color'

/**
 * The end-of-day alert: the lowest-priority capsule alert, shared with new mail and reviews (main
 * ends it after 6 s). "**Llevas 5,5 h de 8 h hoy**". Without a payload (already spent while main still
 * shows the alert) the capsule keeps the icon with no text. It never takes focus; a click opens the
 * Redmine view.
 */
export function RedmineAlert({ alert }: { alert: RedmineAlertPayload | null }) {
  const language = useLanguage()
  const { color } = useIntegration('redmine')
  const number = new Intl.NumberFormat(locale(language), { maximumFractionDigits: 2 })
  const label = alert ? translate(language, 'redmine.alert.behind', { hours: number.format(alert.hours), target: number.format(alert.target) }) : ''

  const open = (event: MouseEvent) => {
    // The capsule's own click would expand; open the Redmine view explicitly instead.
    event.stopPropagation()
    void window.notch.notch.openIntegration({ id: 'redmine' })
  }

  return (
    <div data-testid="redmine-alert" role="status" aria-live="polite" aria-label={label} onClick={open} className="flex h-full items-center gap-2 px-3.5" style={integrationStyle(color)}>
      <RedmineMark size={13} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-[color:var(--int)]" />
      <span className="min-w-0 flex-1 truncate text-body font-semibold text-chalk">{label}</span>
    </div>
  )
}
