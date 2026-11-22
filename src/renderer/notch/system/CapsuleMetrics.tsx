import { BatteryCharging, BatteryLow, BatteryMedium, Database, Microchip, Play, Server, Wifi, WifiOff, type LucideIcon } from 'lucide-react'
import { GmailMark, RedmineMark } from '../../shared/brand-icons'
import type { Platform } from '../../../shared/code-review/schema'
import { capsuleContributionsLabel, capsuleContributionsText, CAPSULE_CONTRIBUTIONS_CAP } from '../../shared/code-review/contributions-format'
import { translate } from '../../../shared/i18n/messages'
import { unreadLabel, unreadText } from '../../shared/gmail/format'
import { hoursLong, hoursText } from '../../shared/redmine/format'
import { PLATFORM_ICONS } from '../code-review/icons'
import { connectionOnline, useOnline } from '../../shared/use-online'
import { useLanguage, useT } from '../../shared/use-t'
import type { CapsuleView } from './capsule-latch'
import type { IntegrationColor } from '../../../shared/integrations/colors'
import { integrationStyle, useIntegration } from '../../shared/integration-color'
import { formatPercent } from './format'
import { durationText } from '../../../shared/work-log/duration'
import type { WorkLogEntryView } from '../../../shared/work-log/schema'
import { useClock } from '../../shared/use-clock'
import { liveTotalMs, useWorkLogStore } from '../../shared/work-log-store'

/** Below this charge the battery icon turns to its low variant; the colour follows the alert only. */
const LOW_BATTERY = 20

/**
 * The system zone of the compact capsule, after the integrations: CPU, RAM, storage, connection and
 * battery (only with one). Each slot carries its own 10 px gap before it (`*:ml-2.5`), so the zone
 * measures as the sum of its slots (COMPACT_ZONE.system, plus COMPACT_ZONE.battery).
 */
export function CapsuleMetrics({ view }: { view: CapsuleView }) {
  const t = useT()
  const language = useLanguage()
  const navigatorOnline = useOnline()
  const { battery, alerts, storage } = view
  // Main's connectivity reading when it has one; navigator offline always wins (see connectionOnline).
  const online = connectionOnline(view.online, navigatorOnline)
  const cpuText = formatPercent(view.cpuPercent, language)
  const ramText = formatPercent(view.ramPercent, language)
  const full = formatPercent(100, language)
  const storageText = storage ? formatPercent(storage.usedPercent, language) : ''

  return (
    <span data-testid="capsule-metrics" className="flex shrink-0 items-center *:ml-2.5">
      <Metric
        icon={Microchip}
        text={cpuText}
        reserve={full}
        alert={alerts.cpu}
        label={t(alerts.cpu ? 'system.capsule.cpuHigh' : 'system.capsule.cpu', { value: cpuText })}
        testId="metric-cpu"
        sans
      />
      <Metric
        icon={Server}
        text={ramText}
        reserve={full}
        alert={alerts.ram}
        label={t(alerts.ram ? 'system.capsule.ramHigh' : 'system.capsule.ram', { value: ramText })}
        testId="metric-ram"
        sans
      />
      {storage && (
        <Metric
          icon={Database}
          text={storageText}
          reserve={full}
          alert={storage.lowDrive !== null}
          label={
            storage.lowDrive !== null
              ? t('system.capsule.storageLow', { value: storageText, letter: storage.lowDrive })
              : t('system.capsule.storage', { value: storageText })
          }
          testId="metric-storage"
          sans
        />
      )}
      {/* Connection: an icon alone, the same 12 px whether online or not, so the width never moves. */}
      <span
        role="img"
        aria-label={t(online ? 'system.capsule.online' : 'system.capsule.offline')}
        data-testid="metric-connection"
        data-online={online}
        className={`flex items-center ${online ? 'text-graphite-glass' : 'text-fail'}`}
      >
        {online ? (
          <Wifi size={12} strokeWidth={2} aria-hidden="true" className="shrink-0" />
        ) : (
          <WifiOff size={12} strokeWidth={2} aria-hidden="true" className="shrink-0" />
        )}
      </span>
      {battery && (
        <Metric
          icon={battery.charging ? BatteryCharging : battery.percent < LOW_BATTERY ? BatteryLow : BatteryMedium}
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
          sans
        />
      )}
    </span>
  )
}

/** Widest unread count the mail block can show (the cap, 100); it fixes the block width. */
const WIDEST_UNREAD = unreadText(100)

/**
 * Unread mail in Primary, an integration block of the compact capsule (Gmail mark + "3" / "99+").
 * Only rendered while the mail latch holds a count; it reserves the width of "99+" (so
 * CAPSULE_BLOCK.mail holds) and sits left, next to its icon.
 */
export function CapsuleMail({ unread }: { unread: number }) {
  const language = useLanguage()
  const { color } = useIntegration('gmail')
  return (
    <Metric
      color={color}
      icon={GmailMark}
      text={unreadText(unread)}
      reserve={WIDEST_UNREAD}
      alert={false}
      align="left"
      label={unreadLabel(unread, language)}
      testId="metric-mail"
    />
  )
}

/** Widest total a contributions block can show (the cap, "999+"); it fixes the block width. */
const WIDEST_CONTRIBUTIONS = capsuleContributionsText(CAPSULE_CONTRIBUTIONS_CAP)

/**
 * A platform's contributions this month (`Github`/`Gitlab` mark + "143" / "999+"), after the mail
 * block. Only rendered while that platform's latch holds a total; like the mail block it reserves
 * its widest text (so CAPSULE_BLOCK.review holds) and sits left, next to its icon.
 */
export function CapsuleContributions({ platform, total, month }: { platform: Platform; total: number; month: string }) {
  const language = useLanguage()
  const { color } = useIntegration(platform)
  return (
    <Metric
      color={color}
      icon={PLATFORM_ICONS[platform]}
      text={capsuleContributionsText(total)}
      reserve={WIDEST_CONTRIBUTIONS}
      alert={false}
      align="left"
      label={capsuleContributionsLabel(platform, total, month, language)}
      testId={`metric-review-${platform}`}
    />
  )
}

/** Widest value the Redmine block can show: a month's hours at their longest (31 × 24), "744,75h" / "744.75h". */
const WIDEST_HOURS = 744.75

/**
 * The hours logged in Redmine this month (mark + "38,5h"), the last integration block. Only rendered
 * while the Redmine latch holds a value; like the other blocks it reserves its widest text (so
 * CAPSULE_BLOCK.redmine holds) and sits left, next to its icon.
 */
export function CapsuleRedmine({ hours }: { hours: number }) {
  const language = useLanguage()
  const { color } = useIntegration('redmine')
  return (
    <Metric
      color={color}
      icon={RedmineMark}
      text={hoursText(hours, language)}
      reserve={hoursText(WIDEST_HOURS, language)}
      alert={false}
      align="left"
      label={translate(language, 'redmine.capsule.month', { hours: hoursLong(hours, language) })}
      testId="metric-redmine"
    />
  )
}

/** The widest live total the block reserves, two-digit hours ("99h 59m"; tabular figures, so any digits measure alike). */
const WIDEST_TOTAL = durationText((99 * 60 + 59) * 60_000)

/**
 * The work log's live session (a play sign and its Total, "1h 25m", in Nunito and the integration's
 * color), after Claude's mark, in the compact capsule and the peek. Only rendered while an entry is
 * running or paused (the latest one); it reserves "99h 59m" so CAPSULE_BLOCK.workLog holds, and moves
 * once a minute. Paused, the play sign dims.
 */
export function CapsuleWorkLog({ entry }: { entry: WorkLogEntryView }) {
  const language = useLanguage()
  const now = useClock().getTime()
  const idlePauseMs = useWorkLogStore((store) => store.idlePauseMs)
  const { color } = useIntegration('workLog')
  const total = durationText(liveTotalMs(entry, now, idlePauseMs))
  const paused = entry.status === 'paused'
  return (
    <span
      role="img"
      aria-label={translate(language, paused ? 'workLog.capsule.paused' : 'workLog.capsule.running', { total })}
      data-testid="metric-work-log"
      data-status={entry.status}
      className="flex items-center gap-1.5 text-[color:var(--int)]"
      style={integrationStyle(color)}
    >
      <Play aria-hidden="true" data-testid="work-log-play" className={`size-2.5 shrink-0 fill-current ${paused ? 'opacity-40' : ''}`} strokeWidth={2.5} />
      <span className="tabular grid whitespace-nowrap text-small font-semibold" aria-hidden="true">
        <span className="invisible [grid-area:1/1]">{WIDEST_TOTAL}</span>
        <span className="text-left [grid-area:1/1]">{total}</span>
      </span>
    </span>
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
  color,
  sans = false,
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
  /** The block's integration color for its icon (mail, reviews, Redmine), whose figure is Tiza. System metrics pass none and stay grey; red wins while alerting. */
  color?: IntegrationColor
  /** The figure in Nunito (the system metrics) instead of Geist Mono (the integration blocks). */
  sans?: boolean
}) {
  return (
    <span
      role="img"
      aria-label={label}
      data-testid={testId}
      data-alert={alert || undefined}
      className={`flex items-center gap-1 ${alert ? 'text-fail' : color ? 'text-chalk' : 'text-graphite-glass'}`}
      style={color ? integrationStyle(color) : undefined}
    >
      <Icon size={12} strokeWidth={2} aria-hidden="true" className={`shrink-0 ${color && !alert ? 'text-[color:var(--int)]' : ''}`} />
      {/* Both texts share one grid cell: the invisible widest value fixes the width, so the capsule
          never jitters as digits change. Right-aligned like a column of figures unless told otherwise. */}
      <span className={`tabular grid whitespace-nowrap text-small font-medium ${sans ? '' : 'font-mono'}`} aria-hidden="true">
        <span className="invisible [grid-area:1/1]">{reserve}</span>
        <span className={`${align === 'left' ? 'text-left' : 'text-right'} [grid-area:1/1]`}>{text}</span>
      </span>
    </span>
  )
}
