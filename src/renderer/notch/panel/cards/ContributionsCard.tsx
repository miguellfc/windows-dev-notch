import type { Platform } from '../../../../shared/code-review/schema'
import { monthName } from '../../../shared/code-review/contributions-format'
import { useCodeReview } from '../../../shared/code-review-store'
import { useLanguage, useT } from '../../../shared/use-t'
import { CardNotice } from './CardNotice'
import { contributionsNotice } from './card-content'
import { MonthSquares } from './MonthSquares'

/** The month in 9 px squares, with its total under them. */
export function ContributionsCard({ platform }: { platform: Platform }) {
  const t = useT()
  const language = useLanguage()
  const notice = useCodeReview((store) => contributionsNotice(store.state?.[platform].status, store.contributions[platform]))
  const summary = useCodeReview((store) => store.contributions[platform]?.summary ?? null)
  if (notice !== null || summary === null) return <CardNotice text={t(notice ?? 'codeReview.contrib.loading')} />
  return (
    <div className="mt-2 flex min-h-0 flex-1 flex-col overflow-hidden">
      <MonthSquares weeks={summary.weeks} />
      <p className="digits mt-auto text-digits-md text-chalk">{summary.monthTotal}</p>
      <p className="mt-1 truncate text-label text-graphite">{t('panel.card.contributions', { month: monthName(summary.month, language) })}</p>
    </div>
  )
}
