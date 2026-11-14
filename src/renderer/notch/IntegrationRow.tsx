import { Activity, AlarmClock, GitPullRequest, Mail, SquareTerminal, StickyNote, type LucideIcon } from 'lucide-react'
import { integrations, type IntegrationId } from '../../shared/integrations/registry'
import { useAttentionCount } from '../shared/reminders-store'
import { remindersBadgeLabel } from '../shared/reminders/format'
import { useLanguage, useT } from '../shared/use-t'
import { loadTerminal } from './terminal-loader'

const icons: Readonly<Record<IntegrationId, LucideIcon>> = {
  terminal: SquareTerminal,
  reminders: AlarmClock,
  system: Activity,
  notes: StickyNote,
  gmail: Mail,
  reviews: GitPullRequest,
}

/** One tile per live integration; clicking opens its mini tool inside the notch. */
export function IntegrationRow() {
  const t = useT()
  const language = useLanguage()
  const remindersDue = useAttentionCount()
  // Six tiles share the 416 px row (flex-1 over each label's own width, px-1.5, 8 px gaps): measured
  // with Playwright at 414 px in ES and EN, so only 2 px spare. A longer label or a seventh tile needs
  // a new measurement; app.spec checks that no label is cut in either language.
  return (
    <section aria-label={t('notch.integrations.label')} className="flex w-full shrink-0 gap-2 px-1">
      {integrations.map(({ id, labelKey }) => {
        const Icon = icons[id]
        const badge = id === 'reminders' && remindersDue > 0 ? remindersDue : 0
        const label = t(labelKey)
        return (
          <button
            key={id}
            type="button"
            data-testid={`integration-${id}`}
            aria-label={badge > 0 ? `${label}, ${remindersBadgeLabel(badge, language)}` : undefined}
            onClick={() => void window.notch.notch.openIntegration({ id })}
            // Intent to open the terminal: fetch its chunk now so it is ready by the click.
            onPointerEnter={id === 'terminal' ? () => void loadTerminal() : undefined}
            onFocus={id === 'terminal' ? () => void loadTerminal() : undefined}
            className="relative flex h-[60px] flex-1 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-tile border border-line bg-veil-tile px-1.5 text-chalk transition-colors duration-150 hover:bg-veil-hover"
          >
            <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
            <span className="max-w-full truncate text-label font-medium">{label}</span>
            {badge > 0 && (
              <span
                data-testid={`integration-${id}-badge`}
                aria-hidden="true"
                className="tabular absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-wait px-1 text-label font-medium leading-none text-on-wait"
              >
                {badge > 99 ? '99+' : badge}
              </span>
            )}
          </button>
        )
      })}
    </section>
  )
}
