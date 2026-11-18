import { ArrowDown, ArrowUp, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { FullSample, LightSample } from '../../../shared/system/schema'
import { useLanguage, useT } from '../../shared/use-t'
import { formatBytes, formatDuration, formatPercent, formatRate } from './format'
import { Ring } from './Ring'
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

const card = 'card flex h-16 min-w-0 items-center gap-2 overflow-hidden px-2.5 py-2'
/** The column beside a ring (or the whole card without one): head on top, line or detail below. */
const column = 'flex h-full min-w-0 flex-1 flex-col justify-between'
const lineColor = 'text-[color:var(--int,var(--color-int-default))]'
const lineAlert = 'text-fail'
const label = 'truncate text-label leading-3.5 font-medium text-graphite'
/**
 * The figure sits under its label (beside the line on CPU and RAM), never on the label's line: in
 * Jersey a digit is ~0.43 em, so "100 %" is ~56 px at 26 px and ~36 px at 17 px, and beside the
 * label it truncated the RAM detail (and the battery label in the four-column grid).
 */
const value = 'digits shrink-0 whitespace-nowrap text-chalk'
/** The same figure in Rojo Fallo, for a metric past its alert threshold. */
const alertValue = 'digits shrink-0 whitespace-nowrap text-fail'

/** CPU and RAM with their last minute, network up/down, and battery when the machine has one. */
export function MetricCards({ sample, network, cpuHistory, ramHistory }: MetricCardsProps) {
  const t = useT()
  const language = useLanguage()
  const battery = sample?.battery ?? null
  // With a battery card the grid is four columns and the rings shrink (see the arithmetic in the task 5 report).
  const ringSize = battery ? 32 : 40
  // Four columns: the figure drops to the 17 px digits so the line beside it keeps some room.
  const digits = battery ? 'text-digits' : 'text-digits-lg'
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
      className={`grid shrink-0 gap-2 ${battery ? 'grid-cols-[11fr_11fr_8fr_8fr]' : 'grid-cols-[5fr_5fr_4fr]'}`}>
      <div
        data-testid="system-card-cpu"
        role="group"
        aria-label={t(cpuAlert ? 'system.capsule.cpuHigh' : 'system.capsule.cpu', { value: cpuText })}
        className={card}
      >
        <Ring percent={sample?.cpuPercent ?? null} alert={cpuAlert} size={ringSize} />
        <div className={column}>
          <span className={label}>{t('system.card.cpu')}</span>
          <span className="flex min-w-0 items-end gap-1.5">
            <Figure value={cpuText} alert={cpuAlert} size={digits} />
            <Sparkline values={cpuHistory} className={`h-4 min-w-0 flex-1 ${cpuAlert ? lineAlert : lineColor}`} />
          </span>
        </div>
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
        <Ring percent={ramPercent(sample)} alert={ramAlert} size={ringSize} />
        <div className={column}>
          <span className={label}>
            {t('system.card.ram')}
            {ram && <span className="tabular font-normal"> · {formatBytes(ram.usedBytes, language)}</span>}
          </span>
          <span className="flex min-w-0 items-end gap-1.5">
            <Figure value={ramText} alert={ramAlert} size={digits} />
            <Sparkline values={ramHistory} className={`h-4 min-w-0 flex-1 ${ramAlert ? lineAlert : lineColor}`} />
          </span>
        </div>
      </div>
      <div data-testid="system-card-network" role="group" aria-label={t('system.card.network')} className={card}>
        <div className={column}>
          <span className={label} aria-hidden="true">
            {t('system.card.network')}
          </span>
          <span className="flex flex-col">
            <Rate icon={ArrowUp} text={upText} label={t('system.card.up', { value: upText })} />
            <Rate icon={ArrowDown} text={downText} label={t('system.card.down', { value: downText })} />
          </span>
        </div>
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
          <div className={column}>
            <span className={label}>{t('system.card.battery')}</span>
            <Figure value={batteryText} alert={batteryAlert} size={digits} />
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
        </div>
      )}
    </div>
  )
}

/** A card's figure; `alert` turns it red (Rojo Fallo), the label stays graphite. */
function Figure({ value: amount, alert, size }: { value: string; alert: boolean; size: string }): ReactNode {
  return <span className={`${alert ? alertValue : value} ${size}`}>{amount}</span>
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
