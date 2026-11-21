import { useEffect } from 'react'
import { localDate } from '../../../../shared/code-review/contributions'
import { monthName, NO_VALUE, placeholderGrid } from '../../../shared/code-review/contributions-format'
import { hoursNumber, hoursText, summaryGrid } from '../../../shared/redmine/format'
import { loadSummary, useRedmine } from '../../../shared/redmine-store'
import { useSettings } from '../../../shared/settings-store'
import { useClock } from '../../../shared/use-clock'
import { useLanguage, useT } from '../../../shared/use-t'
import { CardNotice } from './CardNotice'
import { MonthSquares } from './MonthSquares'
import { redmineNotice } from './card-content'

/** One figure of the card: "5,5h de 8 h hoy" on one line, the pixel digits and their Grafito label. */
function Figure({ hours, label, testId }: { hours: number | null; label: string; testId: string }) {
  const language = useLanguage()
  return (
    <p data-testid={testId} className="flex min-w-0 items-baseline gap-1.5">
      <span className="digits shrink-0 whitespace-nowrap text-digits-md text-chalk">{hours === null ? NO_VALUE : hoursText(hours, language)}</span>
      <span className="min-w-0 truncate text-label text-graphite">{label}</span>
    </p>
  )
}

/**
 * The month in 9 px squares (each day's step against the daily target, as in the Redmine view's
 * chart, today ringed), then today's hours against the target and the month's so far. The squares
 * come from the month summary main keeps with every poll; until it is here (or while it is last
 * month's) the grey grid of this month holds their place.
 */
export function RedmineCard() {
  const t = useT()
  const language = useLanguage()
  const now = useClock()
  const state = useRedmine((store) => store.state)
  const summary = useRedmine((store) => store.summary)
  const target = useSettings((store) => store.settings?.redmine.dailyTargetHours ?? 8)
  const status = state?.status
  const updatedAt = state?.updatedAt ?? null

  // Every reading of a live session comes with a fresh summary in main: read it (no query to Redmine).
  useEffect(() => {
    if (status !== 'ok' && status !== 'offline') return
    void loadSummary()
  }, [status, updatedAt])

  const notice = redmineNotice(state)
  if (notice !== null || !state) return <CardNotice text={t(notice ?? 'panel.card.loading')} />
  const today = localDate(now)
  const month = today.slice(0, 7)
  const weeks = summary?.month === month ? summaryGrid(summary, today, target) : placeholderGrid(now)
  return (
    <div className="mt-2 flex min-h-0 flex-1 flex-col overflow-hidden">
      <MonthSquares weeks={weeks} today={today} />
      <div className="mt-auto flex flex-col gap-1.5">
        <Figure testId="redmine-card-today" hours={state.todayHours} label={t('panel.card.ofTarget', { hours: hoursNumber(target, language) })} />
        <Figure testId="redmine-card-month" hours={state.monthHours} label={t('panel.card.inMonth', { month: monthName(month, language) })} />
      </div>
    </div>
  )
}
