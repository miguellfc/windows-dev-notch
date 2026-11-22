import { durationText } from '../../../../shared/work-log/duration'
import { useClock } from '../../../shared/use-clock'
import { useT } from '../../../shared/use-t'
import { liveTotalMs, useWorkLog } from '../../../shared/work-log-store'
import { liveWorkLogEntry, uninvoicedCount, workLogStatusKey } from '../../../shared/work-log/format'
import { CardNotice } from './CardNotice'

/**
 * The live session's Total (in the integration's color, with its status and project under it) and
 * "N sin imputar" at the foot; without a live session, the count of entries not invoiced yet as the
 * big figure. Live figures move once a minute.
 */
export function WorkLogCard() {
  const t = useT()
  const now = useClock().getTime()
  const { entries, idlePauseMs } = useWorkLog()
  if (entries.length === 0) return <CardNotice text={t('workLog.card.empty')} />
  const live = liveWorkLogEntry(entries)
  const uninvoiced = uninvoicedCount(entries)
  return (
    <div className="mt-2 flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col justify-center gap-1">
        {live ? (
          <>
            <p data-testid="work-log-card-total" className="digits whitespace-nowrap text-digits-lg leading-none text-[color:var(--int)]">
              {durationText(liveTotalMs(live, now, idlePauseMs))}
            </p>
            <p className="truncate text-small text-graphite">
              {live.project === '' ? t(workLogStatusKey(live)) : t('workLog.card.live', { status: t(workLogStatusKey(live)), project: live.project })}
            </p>
          </>
        ) : (
          <>
            <p data-testid="work-log-card-count" className="digits tabular whitespace-nowrap text-digits-lg leading-none text-chalk">
              {uninvoiced}
            </p>
            <p className="truncate text-small text-graphite">{t('workLog.card.uninvoicedLabel')}</p>
          </>
        )}
      </div>
      {live && (
        <p data-testid="work-log-card-uninvoiced" className="tabular truncate text-small text-graphite">
          {t('workLog.card.uninvoiced', { count: uninvoiced })}
        </p>
      )}
    </div>
  )
}
