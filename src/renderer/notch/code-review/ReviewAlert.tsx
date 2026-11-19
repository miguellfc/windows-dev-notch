import { GitPullRequest } from 'lucide-react'
import type { MouseEvent } from 'react'
import type { CodeReviewAlert } from '../../../shared/code-review/schema'
import { translate } from '../../../shared/i18n/messages'
import { setReviewsTarget } from '../../shared/code-review-store'
import { reviewAlertContent, reviewAlertLabel } from '../../shared/code-review/format'
import { useLanguage } from '../../shared/use-t'
import { useSettings } from '../../shared/settings-store'
import { integrationStyle } from '../../shared/integration-color'
import { PLATFORM_ICONS } from './icons'

/**
 * The first-review alert: the lowest-priority capsule alert, shared with new mail (main ends it
 * after 6 s). One PR/MR shows "**Aprobado** · acme/web#12 · título" (or Cambios pedidos / Revisado),
 * several "**2 PR revisados** · GitHub"; without a payload (already spent while main still shows the
 * alert) the plain verdict "Revisado". It never takes focus. A click on a single PR/MR asks main to
 * open it in the browser (main then retracts the alert at once); several, or one main no longer knows, open the
 * reviews view on that platform.
 */
export function ReviewAlert({ alert }: { alert: CodeReviewAlert | null }) {
  const language = useLanguage()
  const content = alert ? reviewAlertContent(alert, language) : null
  const label = alert ? reviewAlertLabel(alert, language) : translate(language, 'codeReview.alert.commented')
  const Icon = alert ? PLATFORM_ICONS[alert.platform] : GitPullRequest
  // The platform's color; a spent payload no longer says the platform, so its generic icon stays chalk.
  const color = useSettings((state) => (alert && state.settings ? state.settings.integrations[alert.platform].color : null))

  const open = (event: MouseEvent): void => {
    // The capsule's own click would expand; open the reviews view explicitly instead.
    event.stopPropagation()
    const openView = () => {
      setReviewsTarget(alert ? { platform: alert.platform } : null)
      void window.notch.notch.openIntegration({ id: 'reviews' })
    }
    if (alert?.count !== 1) return openView()
    void window.notch.codeReview.openAlert({ platform: alert.platform }).then(
      (result) => {
        // Main retracts the alert itself once it opened the page.
        if (!(result.ok && result.data.opened)) openView()
      },
      openView,
    )
  }

  return (
    <div
      data-testid="review-alert"
      role="status"
      aria-live="polite"
      aria-label={label}
      onClick={open}
      className="flex h-full items-center gap-2 px-3.5"
      style={color ? integrationStyle(color) : undefined}
    >
      <Icon size={13} strokeWidth={1.8} aria-hidden="true" className={`shrink-0 ${color ? 'text-[color:var(--int)]' : 'text-chalk'}`} />
      {/* Titles and refs are always plain text: React escapes them. */}
      <span className="min-w-0 flex-1 truncate text-body text-chalk">
        {content === null ? (
          <span className="font-semibold">{label}</span>
        ) : content.kind === 'many' ? (
          <>
            <span className="font-semibold">{content.text}</span>
            <span className="text-graphite-glass"> · {content.platform}</span>
          </>
        ) : (
          <>
            <span className="font-semibold">{content.verdict}</span>
            {content.ref !== null && (
              <>
                <span className="text-graphite-glass"> · </span>
                <span className="tabular text-graphite-glass">{content.ref}</span>
              </>
            )}
            {content.title !== null && (
              <>
                <span className="text-graphite-glass"> · </span>
                <span>{content.title}</span>
              </>
            )}
          </>
        )}
      </span>
    </div>
  )
}
