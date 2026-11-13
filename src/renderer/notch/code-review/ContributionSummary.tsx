import { useId } from 'react'
import type { ContributionSummary as Summary, ContributionTotals, Platform } from '../../../shared/code-review/schema'
import type { MessageKey } from '../../../shared/i18n/messages'
import { monthTotalText, totalText } from '../../shared/code-review/contributions-format'
import { formatUpdated } from '../../shared/gmail/format'
import { useLanguage, useT } from '../../shared/use-t'

type Column = 'today' | 'week' | 'monthTotals'

const COLUMNS: readonly { key: Column; label: MessageKey }[] = [
  { key: 'today', label: 'codeReview.contrib.today' },
  { key: 'week', label: 'codeReview.contrib.week' },
  { key: 'monthTotals', label: 'codeReview.contrib.month' },
]

/** Rows per platform: GitLab says MR where GitHub says PR. */
const ROWS: Readonly<Record<Platform, readonly { key: keyof ContributionTotals; label: MessageKey }[]>> = {
  github: [
    { key: 'commits', label: 'codeReview.contrib.commits' },
    { key: 'opened', label: 'codeReview.contrib.openedPr' },
    { key: 'merged', label: 'codeReview.contrib.mergedPr' },
    { key: 'reviews', label: 'codeReview.contrib.reviews' },
  ],
  gitlab: [
    { key: 'commits', label: 'codeReview.contrib.commits' },
    { key: 'opened', label: 'codeReview.contrib.openedMr' },
    { key: 'merged', label: 'codeReview.contrib.mergedMr' },
    { key: 'reviews', label: 'codeReview.contrib.reviews' },
  ],
}

/**
 * Today · Week · Month × Commits · PR/MR opened · PR/MR merged · Reviews ("—" without data), then
 * "84 contribuciones en noviembre", "Actualizado hace 3 min" and, when they apply, the partial-data,
 * private-contributions and error lines (the error keeps the last data and offers Retry).
 */
export function ContributionSummary({
  platform,
  summary,
  error,
  loading,
  now,
  onRetry,
  retryResting,
  dayText,
}: {
  platform: Platform
  summary: Summary | null
  /** The last query failed (the summary, if any, is the last good one). */
  error: boolean
  loading: boolean
  now: Date
  onRetry: () => void
  /** The refresh rests 5 s after a press, like the header button. */
  retryResting: boolean
  /** The chart's hovered or focused day ("12 nov · 7 contribuciones"): it takes the "Actualizado" line meanwhile. */
  dayText: string | null
}) {
  const t = useT()
  const language = useLanguage()
  const updated = summary ? formatUpdated(summary.updatedAt, now, language) : ''
  const noteId = useId()
  // GitLab's chart counts events (a push is 1), its summary counts commits: say so next to the total.
  const note = platform === 'gitlab' ? t('codeReview.contrib.countNote') : null
  return (
    <div data-testid="contribution-summary" className="flex min-w-[260px] flex-1 flex-col gap-1.5">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">{t('codeReview.contrib.summary')}</caption>
        <thead>
          <tr className="h-4 text-label leading-4 text-graphite">
            <th scope="col" className="p-0 font-normal">
              <span className="sr-only">{t('codeReview.contrib.kind')}</span>
            </th>
            {COLUMNS.map(({ key, label }) => (
              <th key={key} scope="col" className="w-[68px] p-0 text-right font-normal">
                {t(label)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS[platform].map(({ key, label }) => (
            <tr key={key} data-row={key} className="h-5">
              <th scope="row" className="whitespace-nowrap p-0 pr-2 text-small font-normal text-graphite">
                {t(label)}
              </th>
              {COLUMNS.map(({ key: column }) => (
                <td key={column} data-column={column} className="tabular p-0 text-right text-small text-chalk">
                  {totalText(summary?.[column][key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex flex-col text-label leading-4 text-graphite">
        {summary && (
          <>
            <p
              data-testid="contributions-total"
              title={note ?? undefined}
              aria-describedby={note ? noteId : undefined}
              className="text-small leading-[18px] text-chalk"
            >
              {monthTotalText(summary, language)}
            </p>
            {note && (
              <span id={noteId} className="sr-only">
                {note}
              </span>
            )}
            {dayText !== null ? (
              <p aria-hidden="true" data-testid="contribution-day" className="tabular truncate text-chalk">
                {dayText}
              </p>
            ) : (
              updated && <p data-testid="contributions-updated">{updated}</p>
            )}
            {summary.partial && <p data-testid="contributions-partial">{t('codeReview.contrib.partial')}</p>}
            {summary.restricted && <p data-testid="contributions-restricted">{t('codeReview.contrib.restricted')}</p>}
          </>
        )}
        {loading && (
          <p role="status" className="sr-only">
            {t('codeReview.contrib.loading')}
          </p>
        )}
        {error && (
          <p role="status" data-testid="contributions-error" className="flex flex-wrap items-center gap-x-1">
            <span>{t('codeReview.contrib.error')}</span>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              data-testid="contributions-retry"
              onClick={onRetry}
              aria-disabled={retryResting}
              // 24 px tall target (the line stays 16 px); the global ice focus ring shows on keyboard focus.
              className="-my-1 inline-flex min-h-6 cursor-pointer items-center rounded-control-sm px-1 font-medium text-ice underline-offset-2 hover:underline aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:no-underline"
            >
              {t('codeReview.contrib.retry')}
            </button>
          </p>
        )}
      </div>
    </div>
  )
}
