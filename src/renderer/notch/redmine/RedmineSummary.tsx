import { useCallback, useState } from 'react'
import { localDate } from '../../../shared/code-review/contributions'
import type { ContributionDay } from '../../../shared/code-review/schema'
import { translate } from '../../../shared/i18n/messages'
import type { RedmineSummary as Summary } from '../../../shared/redmine/schema'
import type { Language } from '../../../shared/settings/schema'
import { monthName, NO_VALUE, placeholderGrid, shortDate } from '../../shared/code-review/contributions-format'
import { hoursLong, summaryGrid } from '../../shared/redmine/format'
import { useRedmine } from '../../shared/redmine-store'
import { useSettings } from '../../shared/settings-store'
import { useLanguage, useT } from '../../shared/use-t'
import { ContributionGraph } from '../code-review/ContributionGraph'

type Column = 'today' | 'week' | 'monthTotal'

const COLUMNS: readonly { key: Column; label: 'redmine.summary.today' | 'redmine.summary.week' | 'redmine.summary.month' }[] = [
  { key: 'today', label: 'redmine.summary.today' },
  { key: 'week', label: 'redmine.summary.week' },
  { key: 'monthTotal', label: 'redmine.summary.month' },
]

/** What hovering or focusing a square says: "12 nov · 5,5 h"; a future day, only its date. */
const dayText = (day: ContributionDay, language: Language): string => {
  const date = shortDate(day.date, language)
  return day.future ? date : `${date} · ${hoursLong(day.count, language)}`
}

/** The chart for screen readers: "Noviembre: 38,5 h en 6 días activos". */
const srSummary = (summary: Summary, language: Language): string => {
  const active = summary.days.filter((day) => day.date.startsWith(summary.month) && day.hours > 0).length
  const days =
    active === 1
      ? translate(language, 'codeReview.contrib.activeDaysOne')
      : translate(language, 'codeReview.contrib.activeDays', { count: active })
  return translate(language, 'redmine.summary.srSummary', {
    month: monthName(summary.month, language, true),
    hours: hoursLong(summary.monthTotal, language),
    days,
  })
}

/**
 * The hours summary over the issue list: the month chart (one square per day, its colour step by the
 * hours against the daily target) beside Hoy · Semana · Mes, then "38,5 h en noviembre" and the
 * daily target (the hovered day's hours take that line meanwhile). Loading: the grey chart and "—";
 * a failed query keeps the last data with "No se pudieron cargar las horas · Reintentar".
 */
export function RedmineSummary({ now, onRetry, retryResting }: { now: Date; onRetry: () => void; retryResting: boolean }) {
  const t = useT()
  const language = useLanguage()
  const summary = useRedmine((store) => store.summary)
  const error = useRedmine((store) => store.summaryError)
  const target = useSettings((store) => store.settings?.redmine.dailyTargetHours ?? 8)
  const [hovered, setHovered] = useState<string | null>(null)
  const labelOf = useCallback((day: ContributionDay) => dayText(day, language), [language])
  const today = localDate(now)
  const loading = summary === null && !error
  const phase = summary ? 'ready' : error ? 'error' : 'loading'

  return (
    <section
      aria-label={t('redmine.summary.region')}
      data-testid="redmine-summary"
      data-phase={phase}
      aria-busy={loading || undefined}
      className="flex shrink-0 flex-wrap gap-x-5 gap-y-2 border-b border-line px-1.5 pb-2.5 pt-1"
    >
      <ContributionGraph
        weeks={summary ? summaryGrid(summary, today, target) : placeholderGrid(now)}
        month={summary?.month ?? today.slice(0, 7)}
        today={today}
        interactive={summary !== null}
        pulse={loading}
        {...(summary ? { description: srSummary(summary, language), label: t('redmine.summary.graph', { month: monthName(summary.month, language) }) } : {})}
        dayLabel={labelOf}
        onShowDay={setHovered}
      />
      <div data-testid="redmine-summary-totals" className="flex min-w-[260px] flex-1 flex-col gap-1.5">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">{t('redmine.summary.table')}</caption>
          <thead>
            <tr className="h-4 text-label leading-4 text-graphite">
              <th scope="col" className="p-0 font-normal">
                <span className="sr-only">{t('redmine.summary.hours')}</span>
              </th>
              {COLUMNS.map(({ key, label }) => (
                <th key={key} scope="col" className="w-[68px] p-0 text-right font-normal">
                  {t(label)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="h-6">
              <th scope="row" className="whitespace-nowrap p-0 pr-2 text-small font-normal text-graphite">
                {t('redmine.summary.hours')}
              </th>
              {COLUMNS.map(({ key }) => (
                <td key={key} data-column={key} className="digits text-digits whitespace-nowrap p-0 text-right text-chalk">
                  {summary ? hoursLong(summary[key], language) : NO_VALUE}
                </td>
              ))}
            </tr>
          </tbody>
        </table>

        <div className="flex flex-col text-label leading-4 text-graphite">
          {summary && (
            <p data-testid="redmine-summary-total" className="text-small leading-[18px] text-chalk">
              {t('redmine.summary.monthTotal', { hours: hoursLong(summary.monthTotal, language), month: monthName(summary.month, language) })}
            </p>
          )}
          {summary && hovered !== null ? (
            <p aria-hidden="true" data-testid="redmine-summary-day" className="tabular truncate text-chalk">
              {hovered}
            </p>
          ) : (
            <p data-testid="redmine-summary-target">{t('redmine.summary.target', { hours: hoursLong(target, language) })}</p>
          )}
          {loading && (
            <p role="status" className="sr-only">
              {t('redmine.summary.loading')}
            </p>
          )}
          {error && (
            <p role="status" data-testid="redmine-summary-error" className="flex flex-wrap items-center gap-x-1">
              <span>{t('redmine.summary.error')}</span>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                data-testid="redmine-summary-retry"
                onClick={onRetry}
                aria-disabled={retryResting}
                // 24 px tall target (the line stays 16 px); the global focus ring shows on keyboard focus.
                className="-my-1 inline-flex min-h-6 cursor-pointer items-center rounded-control-sm px-1 font-medium text-select underline-offset-2 hover:underline aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:no-underline"
              >
                {t('redmine.summary.retry')}
              </button>
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
