import { useEffect, useState } from 'react'
import icon from '../../../resources/icon.png'
import type { AppInfo } from '../../shared/app-info'
import { DEFAULT_USAGE_RANGE, USAGE_RANGES, type UsageRange, type UsageSummary } from '../../shared/usage/schema'
import { locale, useLanguage, useT } from '../shared/use-t'
import { Segmented } from '../ui/Segmented'

export function AboutPage() {
  const t = useT()
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    void window.notch.app.getInfo().then((result) => {
      if (result.ok) setInfo(result.data)
    })
  }, [])

  return (
    <div>
      <div className="flex items-start gap-4 py-2">
        <img src={icon} alt="" width={48} height={48} className="rounded-[12px]" />
        <div>
          <div className="text-body font-medium">{info?.name ?? 'Developer Notch'}</div>
          {info ? <div className="tabular mt-1 text-small text-graphite">{t('cc.about.version', { version: info.version })}</div> : null}
          <p className="mt-3 max-w-[48ch] text-small text-graphite">{t('cc.about.description')}</p>
        </div>
      </div>
      <UsageSection />
    </div>
  )
}

type UsageState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; summary: UsageSummary }

function UsageSection() {
  const t = useT()
  const language = useLanguage()
  const [range, setRange] = useState<UsageRange>(DEFAULT_USAGE_RANGE)
  const [state, setState] = useState<UsageState>({ status: 'loading' })

  useEffect(() => {
    let current = true
    void window.notch.usage.summary({ days: range }).then((result) => {
      if (current) setState(result.ok ? { status: 'ready', summary: result.data } : { status: 'error' })
    })
    return () => {
      current = false
    }
  }, [range])

  const number = new Intl.NumberFormat(locale(language), { maximumFractionDigits: 1 })
  const ms = (value: number | null) => (value === null ? '—' : t('cc.about.usage.ms', { value: number.format(value) }))
  const options = USAGE_RANGES.map((days) => ({ value: String(days), label: t('cc.about.usage.rangeOption', { days }) }))

  let body = null
  if (state.status === 'error') body = <p className="py-3 text-small text-graphite">{t('cc.about.usage.unavailable')}</p>
  else if (state.status === 'ready') {
    const s = state.summary
    const rows: readonly [string, string][] = [
      [t('cc.about.usage.daysUsed'), number.format(s.days)],
      [t('cc.about.usage.hoursAvg'), number.format(s.runningHoursAvg)],
      [t('cc.about.usage.launches'), number.format(s.launches)],
      [
        t('cc.about.usage.reminders'),
        `${number.format(s.remindersFired)} / ${number.format(s.remindersMissed)} / ${number.format(s.remindersCompleted)}`,
      ],
      [t('cc.about.usage.claudeAlerts'), number.format(s.claudeAlerts)],
      [t('cc.about.usage.latency'), `${ms(s.claudeLatencyMedianMs)} / ${ms(s.claudeLatencyP95Ms)}`],
    ]
    body = (
      <dl>
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-6 border-b border-line py-2.5 last:border-b-0">
            <dt className="text-small text-graphite">{label}</dt>
            <dd className="tabular text-body text-chalk">{value}</dd>
          </div>
        ))}
      </dl>
    )
  }

  return (
    <section aria-labelledby="usage-title" className="mt-8 border-t border-line pt-6">
      <div className="mb-2 flex items-center justify-between gap-4">
        <h2 id="usage-title" className="text-body font-medium text-chalk">
          {t('cc.about.usage.title', { days: range })}
        </h2>
        <Segmented
          label={t('cc.about.usage.range')}
          value={String(range)}
          options={options}
          onChange={(value) => setRange(Number(value) as UsageRange)}
        />
      </div>
      {body}
      <p className="mt-3 text-label text-graphite">{t('cc.about.usage.note')}</p>
    </section>
  )
}
