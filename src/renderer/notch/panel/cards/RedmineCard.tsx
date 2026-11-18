import { hoursNumber, hoursText } from '../../../shared/redmine/format'
import { useRedmine } from '../../../shared/redmine-store'
import { useSettings } from '../../../shared/settings-store'
import { useLanguage, useT } from '../../../shared/use-t'
import { CardNotice } from './CardNotice'
import { redmineNotice, redmineProgress } from './card-content'

/** Today's hours against the daily target. */
export function RedmineCard() {
  const t = useT()
  const language = useLanguage()
  const state = useRedmine((store) => store.state)
  const target = useSettings((store) => store.settings?.redmine.dailyTargetHours ?? 8)
  const notice = redmineNotice(state)
  const hours = state?.todayHours ?? null
  if (notice !== null || hours === null) return <CardNotice text={t(notice ?? 'panel.card.loading')} />
  return (
    <div className="mt-2 flex min-h-0 flex-1 flex-col justify-center overflow-hidden">
      <p className="digits whitespace-nowrap text-digits-lg text-chalk">{hoursText(hours, language)}</p>
      <p className="mt-1.5 truncate text-small text-graphite">{t('panel.card.ofTarget', { hours: hoursNumber(target, language) })}</p>
      <div aria-hidden="true" className="mt-3 h-1.5 overflow-hidden rounded-full bg-veil-tile">
        <div className="h-full rounded-full bg-[color:var(--int)]" style={{ width: `${redmineProgress(hours, target) * 100}%` }} />
      </div>
    </div>
  )
}
