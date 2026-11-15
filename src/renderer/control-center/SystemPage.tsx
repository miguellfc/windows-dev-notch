import { useEffect, useId, useState } from 'react'
import type { MessageKey } from '../../shared/i18n/messages'
import type { Settings, SystemAlertSettings } from '../../shared/settings/schema'
import { useSettings } from '../shared/settings-store'
import { useT } from '../shared/use-t'
import { Switch } from '../ui/Switch'
import { SettingRow } from './ControlCenterApp'
import { ALERT_RANGES, createAlertSaver, parseAlertField, type Range } from './system-alerts-form'

const field =
  'tabular h-8 w-16 rounded-control border border-line bg-veil px-2 text-center text-body text-chalk outline-none transition-colors duration-150 focus:border-ice/60 aria-invalid:border-fail/60 aria-disabled:cursor-not-allowed aria-disabled:opacity-40'

/**
 * A whole-number field and its unit, as two cells of the controls grid, validated on blur or Enter.
 * Out of range or not an integer shows the allowed range under it and saves nothing; a valid value
 * is saved straight away.
 */
function NumberField({
  label,
  value,
  range,
  disabled,
  onCommit,
  suffix,
}: {
  label: string
  value: number
  range: Range
  disabled: boolean
  onCommit: (value: number) => void
  suffix: string
}) {
  const t = useT()
  const errorId = useId()
  const [draft, setDraft] = useState(String(value))
  const [invalid, setInvalid] = useState(false)

  // A change made elsewhere (another window, a saved edit) replaces what is shown, and so does
  // switching the alert off: a disabled field never keeps a rejected draft or its error.
  useEffect(() => {
    setDraft(String(value))
    setInvalid(false)
  }, [value, disabled])

  const commit = () => {
    const parsed = parseAlertField(draft, range)
    if (!parsed.ok) return setInvalid(true)
    setInvalid(false)
    setDraft(String(parsed.value))
    if (parsed.value !== value) onCommit(parsed.value)
  }

  return (
    <>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        aria-label={label}
        aria-disabled={disabled || undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
        readOnly={disabled}
        tabIndex={disabled ? -1 : undefined}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => !disabled && commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !disabled) commit()
        }}
        className={field}
      />
      <span aria-hidden="true" className={`justify-self-start text-small text-graphite ${disabled ? 'opacity-40' : ''}`}>
        {suffix}
      </span>
      {invalid && (
        <span id={errorId} role="alert" className="col-span-2 -mt-1 justify-self-start text-small text-fail">
          {t('cc.system.range', { min: range.min, max: range.max })}
        </span>
      )}
    </>
  )
}

type Key = keyof SystemAlertSettings

/** One saver for the page (module level, so a remount cannot start a second queue): edits never overwrite each other. */
const alertSaver = createAlertSaver(
  () => useSettings.getState().settings?.systemAlerts,
  (systemAlerts) => useSettings.getState().update({ systemAlerts }),
)

function save<K extends Key>(key: K, change: Partial<SystemAlertSettings[K]>, fallback: SystemAlertSettings): void {
  void alertSaver.save(key, change, fallback)
}

export function SystemPage({ settings }: { settings: Settings }) {
  const t = useT()
  const alerts = settings.systemAlerts

  const rows: readonly { key: Key; name: MessageKey; hint: string; range: Range; value: number }[] = [
    {
      key: 'cpu',
      name: 'cc.system.cpu',
      hint: t('cc.system.cpuHint', { percent: alerts.cpu.percent, seconds: alerts.cpu.sustainSeconds }),
      range: ALERT_RANGES.cpuPercent,
      value: alerts.cpu.percent,
    },
    {
      key: 'ram',
      name: 'cc.system.ram',
      hint: t('cc.system.ramHint', { percent: alerts.ram.percent }),
      range: ALERT_RANGES.ramPercent,
      value: alerts.ram.percent,
    },
    {
      key: 'battery',
      name: 'cc.system.battery',
      hint: t('cc.system.batteryHint', { percent: alerts.battery.percent }),
      range: ALERT_RANGES.batteryPercent,
      value: alerts.battery.percent,
    },
    {
      key: 'disk',
      name: 'cc.system.disk',
      hint: t('cc.system.diskHint', { percent: alerts.disk.freePercent }),
      range: ALERT_RANGES.diskFreePercent,
      value: alerts.disk.freePercent,
    },
  ]

  return (
    <div data-testid="system-alerts-page">
      <p className="mb-2 text-small text-graphite">{t('cc.system.note')}</p>
      {rows.map(({ key, name, hint, range, value }) => {
        const enabled = alerts[key].enabled
        const label = t(name)
        return (
          <SettingRow key={key} label={label} hint={hint}>
            <div className="flex items-start gap-4">
              {/* Fixed columns (field, unit) so every row's fields line up, whatever its unit. */}
              <div className="grid grid-cols-[4rem_7.75rem] items-center gap-x-1.5 gap-y-2">
                <NumberField
                  label={t('cc.system.threshold', { name: label })}
                  value={value}
                  range={range}
                  disabled={!enabled}
                  suffix="%"
                  onCommit={(next) => save(key, key === 'disk' ? { freePercent: next } : { percent: next }, alerts)}
                />
                {key === 'cpu' && (
                  <NumberField
                    label={t('cc.system.seconds')}
                    value={alerts.cpu.sustainSeconds}
                    range={ALERT_RANGES.cpuSeconds}
                    disabled={!enabled}
                    suffix={t('cc.system.secondsUnit')}
                    onCommit={(sustainSeconds) => save('cpu', { sustainSeconds }, alerts)}
                  />
                )}
              </div>
              {/* As tall as a field, so the switch sits level with the first one. */}
              <div className="flex h-8 items-center">
                <Switch
                  label={t('cc.system.enable', { name: label })}
                  checked={enabled}
                  onChange={(next) => save(key, { enabled: next }, alerts)}
                />
              </div>
            </div>
          </SettingRow>
        )
      })}
    </div>
  )
}
