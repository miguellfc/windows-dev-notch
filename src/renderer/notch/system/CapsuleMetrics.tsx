import { Battery, BatteryCharging, BatteryLow, Cpu, MemoryStick, type LucideIcon } from 'lucide-react'
import { useLanguage, useT } from '../../shared/use-t'
import type { CapsuleView } from './capsule-latch'
import { formatPercent } from './format'

/** Below this charge the battery icon turns to its low variant; never an alarm colour. */
const LOW_BATTERY = 20

/** CPU, RAM and battery percentages for the compact capsule, after the time and date. */
export function CapsuleMetrics({ view }: { view: CapsuleView }) {
  const t = useT()
  const language = useLanguage()
  const battery = view.battery
  const cpuText = formatPercent(view.cpuPercent, language)
  const ramText = formatPercent(view.ramPercent, language)

  return (
    <span data-testid="capsule-metrics" className="flex shrink-0 items-center gap-2.5">
      <Metric icon={Cpu} text={cpuText} label={t('system.capsule.cpu', { value: cpuText })} testId="metric-cpu" />
      <Metric icon={MemoryStick} text={ramText} label={t('system.capsule.ram', { value: ramText })} testId="metric-ram" />
      {battery && (
        <Metric
          icon={battery.charging ? BatteryCharging : battery.percent < LOW_BATTERY ? BatteryLow : Battery}
          text={formatPercent(battery.percent, language)}
          label={t(
            battery.charging
              ? 'system.capsule.batteryCharging'
              : battery.pluggedIn
                ? 'system.capsule.batteryPluggedIn'
                : 'system.capsule.battery',
            { value: formatPercent(battery.percent, language) },
          )}
          testId="metric-battery"
        />
      )}
    </span>
  )
}

function Metric({ icon: Icon, text, label, testId }: { icon: LucideIcon; text: string; label: string; testId: string }) {
  const language = useLanguage()
  return (
    <span role="img" aria-label={label} data-testid={testId} className="flex items-center gap-1 text-graphite-glass">
      <Icon size={12} strokeWidth={2} aria-hidden="true" className="shrink-0" />
      {/* Both texts share one grid cell: the invisible widest value ("100 %") fixes the width, so the
          capsule never jitters as digits change. Right-aligned like a column of figures. */}
      <span className="tabular grid whitespace-nowrap text-small font-medium" aria-hidden="true">
        <span className="invisible [grid-area:1/1]">{formatPercent(100, language)}</span>
        <span className="text-right [grid-area:1/1]">{text}</span>
      </span>
    </span>
  )
}
