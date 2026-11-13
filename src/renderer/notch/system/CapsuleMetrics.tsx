import { Battery, BatteryCharging, BatteryLow, Cpu, HardDrive, Mail, MemoryStick, type LucideIcon } from 'lucide-react'
import type { Platform } from '../../../shared/code-review/schema'
import { reviewCountText, unreviewedLabel } from '../../shared/code-review/format'
import { unreadLabel, unreadText } from '../../shared/gmail/format'
import { PLATFORM_ICONS } from '../code-review/icons'
import { useLanguage, useT } from '../../shared/use-t'
import type { CapsuleView } from './capsule-latch'
import { formatPercent } from './format'

/** Below this charge the battery icon turns to its low variant; the colour follows the alert only. */
const LOW_BATTERY = 20

/** Widest drive letter in the capsule font, so the disk block keeps its width whatever the drive. */
const WIDEST_DRIVE_LETTER = 'W'

/** CPU, RAM, battery and (only while space is low) disk for the compact capsule, after time and date. */
export function CapsuleMetrics({ view }: { view: CapsuleView }) {
  const t = useT()
  const language = useLanguage()
  const { battery, alerts, disk } = view
  const cpuText = formatPercent(view.cpuPercent, language)
  const ramText = formatPercent(view.ramPercent, language)
  const full = formatPercent(100, language)

  return (
    <span data-testid="capsule-metrics" className="flex shrink-0 items-center gap-2.5">
      <Metric
        icon={Cpu}
        text={cpuText}
        reserve={full}
        alert={alerts.cpu}
        label={t(alerts.cpu ? 'system.capsule.cpuHigh' : 'system.capsule.cpu', { value: cpuText })}
        testId="metric-cpu"
      />
      <Metric
        icon={MemoryStick}
        text={ramText}
        reserve={full}
        alert={alerts.ram}
        label={t(alerts.ram ? 'system.capsule.ramHigh' : 'system.capsule.ram', { value: ramText })}
        testId="metric-ram"
      />
      {battery && (
        <Metric
          icon={battery.charging ? BatteryCharging : battery.percent < LOW_BATTERY ? BatteryLow : Battery}
          text={formatPercent(battery.percent, language)}
          reserve={full}
          alert={alerts.battery}
          label={t(
            alerts.battery
              ? 'system.capsule.batteryLow'
              : battery.charging
                ? 'system.capsule.batteryCharging'
                : battery.pluggedIn
                  ? 'system.capsule.batteryPluggedIn'
                  : 'system.capsule.battery',
            { value: formatPercent(battery.percent, language) },
          )}
          testId="metric-battery"
        />
      )}
      {disk && (
        <Metric
          icon={HardDrive}
          text={`${disk.letter}: ${formatPercent(disk.freePercent, language)}`}
          reserve={`${WIDEST_DRIVE_LETTER}: ${full}`}
          alert
          label={t('system.capsule.diskLow', { letter: disk.letter, value: formatPercent(disk.freePercent, language) })}
          testId="metric-disk"
        />
      )}
    </span>
  )
}

/** Widest unread count the mail block can show (the cap, 100); it fixes the block width. */
const WIDEST_UNREAD = unreadText(100)

/**
 * Unread mail in Primary, last in the compact capsule (`Mail` + "3" / "99+"), in Grafito Cristal.
 * Only rendered while the mail latch holds a count; it reserves the width of "99+" (so the
 * measured COMPACT_WIDTHS hold) but sits left, next to its icon: it is the last block, so the
 * spare room falls at the capsule's edge instead of between the icon and the figure.
 */
export function CapsuleMail({ unread }: { unread: number }) {
  const language = useLanguage()
  return (
    <Metric
      icon={Mail}
      text={unreadText(unread)}
      reserve={WIDEST_UNREAD}
      alert={false}
      align="left"
      label={unreadLabel(unread, language)}
      testId="metric-mail"
    />
  )
}

/** Widest unreviewed count a code-review block can show (the cap, 100); it fixes the block width. */
const WIDEST_UNREVIEWED = reviewCountText(100)

/**
 * A platform's own unreviewed PR/MRs (`Github`/`Gitlab` mark + "2" / "99+"), after the mail block,
 * in Grafito Cristal. Only rendered while that platform's latch holds a count; like the mail block
 * it reserves "99+" (so REVIEW_BLOCK_WIDTH holds) and sits left, next to its icon.
 */
export function CapsuleReview({ platform, count }: { platform: Platform; count: number }) {
  const language = useLanguage()
  return (
    <Metric
      icon={PLATFORM_ICONS[platform]}
      text={reviewCountText(count)}
      reserve={WIDEST_UNREVIEWED}
      alert={false}
      align="left"
      label={unreviewedLabel(platform, count, language)}
      testId={`metric-review-${platform}`}
    />
  )
}

function Metric({
  icon: Icon,
  text,
  reserve,
  alert,
  align = 'right',
  label,
  testId,
}: {
  icon: LucideIcon
  text: string
  /** The widest value this slot can show; it fixes the slot width. */
  reserve: string
  /** Rojo Fallo on icon and number while the metric is alerting; colour only, same width. */
  alert: boolean
  /** Right for the percentages (a column of figures); left for the mail count. */
  align?: 'left' | 'right'
  label: string
  testId: string
}) {
  return (
    <span
      role="img"
      aria-label={label}
      data-testid={testId}
      data-alert={alert || undefined}
      className={`flex items-center gap-1 ${alert ? 'text-fail' : 'text-graphite-glass'}`}
    >
      <Icon size={12} strokeWidth={2} aria-hidden="true" className="shrink-0" />
      {/* Both texts share one grid cell: the invisible widest value fixes the width, so the capsule
          never jitters as digits change. Right-aligned like a column of figures unless told otherwise. */}
      <span className="tabular grid whitespace-nowrap text-small font-medium" aria-hidden="true">
        <span className="invisible [grid-area:1/1]">{reserve}</span>
        <span className={`${align === 'left' ? 'text-left' : 'text-right'} [grid-area:1/1]`}>{text}</span>
      </span>
    </span>
  )
}
