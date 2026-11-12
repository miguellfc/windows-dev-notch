import { Mail } from 'lucide-react'
import type { MouseEvent } from 'react'
import type { GmailNewMail } from '../../../shared/gmail/schema'
import { translate } from '../../../shared/i18n/messages'
import { setReading } from '../../shared/gmail-store'
import { mailAlertContent, mailAlertLabel, type MailAlertContent } from '../../shared/gmail/format'
import { useLanguage } from '../../shared/use-t'

/**
 * The new-mail alert: the lowest-priority capsule alert (main ends it after 6 s). One mail shows
 * "Ana García · Presupuesto…", hidden content "Correo nuevo", several "3 correos nuevos"; without a
 * payload (already spent while main still shows the alert) "Correo nuevo". It never takes focus; a
 * click opens the Gmail view, straight on the reader for a single mail.
 */
export function MailAlert({ mail }: { mail: GmailNewMail | null }) {
  const language = useLanguage()
  const content: MailAlertContent = mail ? mailAlertContent(mail, language) : { kind: 'plain', text: translate(language, 'gmail.alert.new') }
  const label = mail ? mailAlertLabel(mail, language) : translate(language, 'gmail.alert.new')

  const open = (event: MouseEvent) => {
    // The capsule's own click would expand; open Gmail explicitly instead.
    event.stopPropagation()
    setReading(mail?.count === 1 ? mail.id : null)
    void window.notch.notch.openIntegration({ id: 'gmail' })
  }

  return (
    <div
      data-testid="mail-alert"
      role="status"
      aria-live="polite"
      aria-label={label}
      onClick={open}
      className="flex h-full items-center gap-2 px-3.5"
    >
      <Mail size={13} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-ice" />
      {/* Mail text is always plain text: React escapes it. */}
      <span className="min-w-0 flex-1 truncate text-body text-chalk">
        {content.kind === 'content' ? (
          <>
            <span className="font-medium">{content.from}</span>
            <span className="text-graphite-glass"> · </span>
            <span>{content.subject}</span>
          </>
        ) : (
          <span className="font-medium">{content.text}</span>
        )}
      </span>
    </div>
  )
}
