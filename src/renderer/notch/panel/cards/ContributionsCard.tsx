import type { ContributionDay, Platform } from '../../../../shared/code-review/schema'
import type { MessageKey } from '../../../../shared/i18n/messages'
import { contributionsPhase, monthName } from '../../../shared/code-review/contributions-format'
import { useCodeReview } from '../../../shared/code-review-store'
import { useLanguage, useT } from '../../../shared/use-t'
import { LEVEL_FILL } from '../../code-review/ContributionGraph'
import { CardNotice } from './CardNotice'

/** The notice that takes the card's place; null once there is a month to show. */
function noticeKey(platform: Platform): (store: ReturnType<typeof useCodeReview.getState>) => MessageKey | null {
  return (store) => {
    const status = store.state?.[platform].status
    if (status === 'unconfigured') return 'codeReview.state.unconfigured'
    if (status === 'auth-error') return 'codeReview.state.auth'
    const { phase } = contributionsPhase(store.contributions[platform])
    if (phase === 'ready') return null
    if (status === 'offline') return 'codeReview.view.offline'
    return phase === 'error' ? 'codeReview.contrib.error' : 'codeReview.contrib.loading'
  }
}

function dayFill(day: ContributionDay): string {
  if (!day.inMonth) return ''
  return day.future ? 'border border-line' : LEVEL_FILL[day.level]
}

/** The month in 9 px squares, with its total under them. */
export function ContributionsCard({ platform }: { platform: Platform }) {
  const t = useT()
  const language = useLanguage()
  const notice = useCodeReview(noticeKey(platform))
  const summary = useCodeReview((store) => store.contributions[platform]?.summary ?? null)
  if (notice !== null || summary === null) return <CardNotice text={t(notice ?? 'codeReview.contrib.loading')} />
  return (
    <div className="mt-2 flex min-h-0 flex-1 flex-col overflow-hidden">
      <div aria-hidden="true" className="flex gap-0.5">
        {summary.weeks.map((week) => (
          <div key={week[0]?.date} className="flex flex-col gap-0.5">
            {week.map((day) => (
              <span key={day.date} className={`block size-[9px] rounded-[2px] ${dayFill(day)}`} />
            ))}
          </div>
        ))}
      </div>
      <p className="digits mt-auto text-digits-md text-chalk">{summary.monthTotal}</p>
      <p className="mt-1 truncate text-label text-graphite">{t('panel.card.contributions', { month: monthName(summary.month, language) })}</p>
    </div>
  )
}
