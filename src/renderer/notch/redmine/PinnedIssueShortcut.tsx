import { Pin } from 'lucide-react'
import type { ReactNode } from 'react'
import { integrationStyle, useIntegration } from '../../shared/integration-color'
import { shortcutShown } from '../../shared/redmine/pin'
import { openPinnedIssue, useRedmine } from '../../shared/redmine-store'
import { useSettings } from '../../shared/settings-store'
import { useT } from '../../shared/use-t'
import { headerIconButton } from '../reminders/styles'

/**
 * The header shortcut to the pinned Redmine issue: opens its detail in the Redmine view from any
 * view. Absent without a pin, without a live session or with the integration off, and inside the
 * pinned issue's own detail (`currentId`). Painted in Redmine's colour whatever the host view's.
 * `className` adds to the button (`ml-auto` where nothing else is pushed right); `buttonClass`
 * swaps the view headers' look for another (the panel's, to match its gear).
 */
export function PinnedIssueShortcut({ currentId, className = '', buttonClass = headerIconButton }: { currentId?: number | null; className?: string; buttonClass?: string }): ReactNode {
  const t = useT()
  const pinned = useRedmine((store) => store.pinned)
  const status = useRedmine((store) => store.state?.status)
  const integrations = useSettings((store) => store.settings?.integrations ?? null)
  const { color } = useIntegration('redmine')
  if (pinned === null || !shortcutShown(pinned, status, integrations, currentId)) return null
  // An empty subject (pinned before the issue loaded) leaves no trailing space in the name.
  const label = t('redmine.pin.open', { id: String(pinned.id), subject: pinned.subject }).trim()
  return (
    <button
      type="button"
      data-testid="redmine-pinned-shortcut"
      onClick={openPinnedIssue}
      aria-label={label}
      title={label}
      style={integrationStyle(color)}
      className={`${buttonClass} ${className}`}
    >
      {/* On the icon: the button classes carry their own text colour, which would win on the button. */}
      <Pin size={14} strokeWidth={1.8} aria-hidden="true" className="text-[color:var(--int)]" />
    </button>
  )
}
