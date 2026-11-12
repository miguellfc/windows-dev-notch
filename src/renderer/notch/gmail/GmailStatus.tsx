import { Inbox, LogIn, Mail, MailWarning, type LucideIcon } from 'lucide-react'
import type { MessageKey } from '../../../shared/i18n/messages'
import { useT } from '../../shared/use-t'

export type GmailNotice = 'unconfigured' | 'signed-out' | 'signing-in' | 'expired' | 'empty'

const NOTICES: Readonly<Record<GmailNotice, { icon: LucideIcon; title: MessageKey; hint?: MessageKey; action: boolean }>> = {
  unconfigured: { icon: Mail, title: 'gmail.state.unconfigured', action: true },
  'signed-out': { icon: LogIn, title: 'gmail.state.signedOut', action: true },
  'signing-in': { icon: LogIn, title: 'gmail.state.signingIn', action: false },
  expired: { icon: MailWarning, title: 'gmail.state.expired', hint: 'gmail.state.expiredHint', action: true },
  empty: { icon: Inbox, title: 'gmail.state.empty', action: false },
}

const button =
  'flex h-8 cursor-pointer items-center rounded-control border border-line bg-veil-tile px-3 text-small font-medium text-chalk transition-colors duration-150 hover:bg-veil-hover'

/**
 * Everything the view shows instead of the list: no client, no session, waiting for the browser,
 * an expired session (with a way to the Control Center's Gmail page), or an empty Primary tab.
 */
export function GmailStatus({ notice }: { notice: GmailNotice }) {
  const t = useT()
  const { icon: Icon, title, hint, action } = NOTICES[notice]
  return (
    <div
      role="status"
      data-testid="gmail-status"
      data-notice={notice}
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 pb-4 text-center"
    >
      <Icon size={20} strokeWidth={1.8} aria-hidden="true" className="text-graphite" />
      <p className="text-body text-chalk">{t(title)}</p>
      {hint && <p className="text-small text-graphite">{t(hint)}</p>}
      {action && (
        <button
          type="button"
          data-testid="gmail-open-control-center"
          onClick={() => void window.notch.app.openControlCenter({ page: 'gmail' })}
          className={`${button} mt-1`}
        >
          {t('gmail.state.openControlCenter')}
        </button>
      )}
    </div>
  )
}

/** Five placeholder rows while the first list loads; the pulse stops with reduced motion. */
export function GmailSkeleton() {
  const t = useT()
  return (
    <div data-testid="gmail-loading" aria-busy="true" className="-mx-1 flex min-h-0 flex-1 flex-col overflow-hidden px-1">
      <p role="status" className="sr-only">
        {t('gmail.state.loading')}
      </p>
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} aria-hidden="true" className="flex h-[58px] shrink-0 flex-col justify-center gap-2 px-2.5 pl-[22px]">
          <span className="h-2.5 w-2/5 animate-pulse rounded-full bg-veil-tile motion-reduce:animate-none" />
          <span className="h-2 w-3/4 animate-pulse rounded-full bg-veil-tile motion-reduce:animate-none" />
          <span className="h-2 w-3/5 animate-pulse rounded-full bg-veil motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  )
}
