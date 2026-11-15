import { ArrowDown, ArrowUp, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { FullSample, LightSample } from '../../../shared/system/schema'
import { useLanguage, useT } from '../../shared/use-t'
import { formatBytes, formatDuration, formatPercent, formatRate } from './format'
import { Sparkline } from './Sparkline'

/** RAM in use as a percentage; null when it could not be read. */
export function ramPercent(sample: LightSample | null): number | null {
  const ram = sample?.ram
  return ram && ram.totalBytes > 0 ? (ram.usedBytes / ram.totalBytes) * 100 : null
}

interface MetricCardsProps {
  /** Latest light or full sample; null before the first one. */
  sample: LightSample | null
  /** Network rates; undefined while only light samples have arrived (no network reading yet). */
  network: FullSample['network'] | undefined
  cpuHistory: readonly number[]
  ramHistory: readonly number[]
}

const card = 'flex h-[60px] min-w-0 flex-col justify-between rounded-tile border border-line bg-veil px-2.5 py-2'
const label = 'truncate text-label leading-3.5 font-medium text-graphite'
const value = 'tabular shrink-0 whitespace-nowrap text-body font-medium text-chalk'
/** The same figure in Rojo Fallo, for a metric past its alert threshold. */
const alertValue = 'tabular shrink-0 whitespace-nowrap text-body font-medium text-fail'

/** CPU and RAM with their last minute, network up/down, and battery when the machine has one. */
export function MetricCards({ sample, network, cpuHistory, ramHistory }: MetricCardsProps) {
  const t = useT()
  const language = useLanguage()
  const battery = sample?.battery ?? null
  const alerts = sample?.alerts
  const cpuAlert = alerts?.cpu === true
  const ramAlert = alerts?.ram === true
  const batteryAlert = alerts?.battery === true
  const batteryText = battery ? formatPercent(battery.percent, language) : ''
  const cpuText = formatPercent(sample?.cpuPercent ?? null, language)
  const ram = sample?.ram ?? null
  const ramText = formatPercent(ramPercent(sample), language)
  const upText = network ? formatRate(network.upBytesPerSec, language) : '—'
  const downText = network ? formatRate(network.downBytesPerSec, language) : '—'

  return (
    <div
      data-testid="system-cards"
      // CPU and RAM carry a line (and RAM a detail), so they get a little more room than the rest.
      className={`grid shrink-0 gap-2 ${battery ? 'grid-cols-[5fr_5fr_4fr_4fr]' : 'grid-cols-[5fr_5fr_4fr]'}`}>
      <div
        data-testid="system-card-cpu"
        role="group"
        aria-label={t(cpuAlert ? 'system.capsule.cpuHigh' : 'system.capsule.cpu', { value: cpuText })}
        className={card}
      >
        <CardHead label={t('system.card.cpu')} value={cpuText} alert={cpuAlert} />
        <Sparkline values={cpuHistory} className="h-5 w-full text-graphite" />
      </div>
      <div
        data-testid="system-card-ram"
        role="group"
        aria-label={
          ramAlert
            ? t('system.capsule.ramHigh', { value: ramText })
            : ram
            ? t('system.card.ramDetail', {
                percent: ramText,
                used: formatBytes(ram.usedBytes, language),
                total: formatBytes(ram.totalBytes, language),
              })
            : t('system.capsule.ram', { value: ramText })
        }
        className={card}
      >
        <CardHead
          label={t('system.card.ram')}
          detail={ram ? formatBytes(ram.usedBytes, language) : undefined}
          value={ramText}
          alert={ramAlert}
        />
        <Sparkline values={ramHistory} className="h-5 w-full text-graphite" />
      </div>
      <div data-testid="system-card-network" role="group" aria-label={t('system.card.network')} className={card}>
        <span className={label} aria-hidden="true">
          {t('system.card.network')}
        </span>
        <span className="flex flex-col">
          <Rate icon={ArrowUp} text={upText} label={t('system.card.up', { value: upText })} />
          <Rate icon={ArrowDown} text={downText} label={t('system.card.down', { value: downText })} />
        </span>
      </div>
      {battery && (
        <div
          data-testid="system-card-battery"
          role="group"
          aria-label={
            batteryAlert ? t('system.capsule.batteryLow', { value: batteryText }) : t('system.card.battery')
          }
          className={card}
        >
          <CardHead label={t('system.card.battery')} value={batteryText} alert={batteryAlert} />
          <span className="truncate text-label leading-3.5 text-graphite">
            {battery.charging
              ? t('system.card.charging')
              : battery.pluggedIn
                ? t('system.card.pluggedIn')
                : battery.secondsLeft !== null
                  ? t('system.card.timeLeft', { time: formatDuration(battery.secondsLeft, language) })
                  : t('system.card.onBattery')}
          </span>
        </div>
      )}
    </div>
  )
}

/** `alert` turns the figure red (Rojo Fallo); the label stays graphite. */
function CardHead({
  label: text,
  detail,
  value: amount,
  alert = false,
}: {
  label: string
  detail?: string | undefined
  value: string
  alert?: boolean
}): ReactNode {
  return (
    <span className="flex items-baseline justify-between gap-1.5">
      <span className={label}>
        {text}
        {detail && <span className="tabular font-normal"> · {detail}</span>}
      </span>
      <span className={alert ? alertValue : value}>{amount}</span>
    </span>
  )
}

function Rate({ icon: Icon, text, label: name }: { icon: LucideIcon; text: string; label: string }) {
  return (
    <span role="img" aria-label={name} className="flex items-center gap-1 text-label leading-3.5 text-chalk">
      <Icon size={11} strokeWidth={2} aria-hidden="true" className="shrink-0 text-graphite" />
      <span className="tabular truncate" aria-hidden="true">
        {text}
      </span>
    </span>
  )
}
