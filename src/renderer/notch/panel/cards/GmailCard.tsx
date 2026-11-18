import type { MessageKey } from '../../../../shared/i18n/messages'
import { subjectText } from '../../../shared/gmail/format'
import { useGmail } from '../../../shared/gmail-store'
import { useLanguage, useT } from '../../../shared/use-t'
import { CardNotice } from './CardNotice'
import { gmailCardBody, type GmailCardBody } from './card-content'

const MAILS_SHOWN = 3

const NOTICES: Readonly<Record<Exclude<GmailCardBody, 'list'>, MessageKey>> = {
  loading: 'gmail.state.loading',
  empty: 'gmail.state.empty',
  offline: 'gmail.view.offline',
  unconfigured: 'gmail.state.unconfigured',
  'signed-out': 'gmail.state.signedOut',
  'signing-in': 'gmail.state.signingIn',
  expired: 'gmail.state.expired',
}

/** The latest mails: the sender in bold while unread, the subject on one line. */
export function GmailCard() {
  const t = useT()
  const language = useLanguage()
  const state = useGmail((store) => store.state)
  const recent = useGmail((store) => store.recent)
  const body = gmailCardBody(state, recent)
  if (body !== 'list') return <CardNotice text={t(NOTICES[body])} />
  return (
    <ul className="mt-2 flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
      {(recent ?? []).slice(0, MAILS_SHOWN).map((mail) => (
        <li key={mail.id} className="min-w-0">
          <p className={`truncate text-small text-chalk ${mail.unread ? 'font-semibold' : 'font-normal'}`}>{mail.from}</p>
          <p className="truncate text-label text-graphite">{subjectText(mail.subject, language)}</p>
        </li>
      ))}
    </ul>
  )
}
