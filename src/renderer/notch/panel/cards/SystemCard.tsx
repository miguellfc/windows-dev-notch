import { useSystem } from '../../../shared/system-store'
import { useLanguage, useT } from '../../../shared/use-t'
import { formatPercent } from '../../system/format'
import { Ring } from '../../system/Ring'

const NO_DRIVE = '—'

function Gauge({ name, percent, alert, label }: { name: string; percent: number | null; alert: boolean; label: string }) {
  const language = useLanguage()
  return (
    <li role="img" aria-label={label} className="flex w-12 min-w-0 flex-col items-center gap-1">
      <Ring percent={percent} alert={alert} size={40} />
      <span aria-hidden="true" className={`tabular whitespace-nowrap text-small font-medium ${alert ? 'text-fail' : 'text-chalk'}`}>
        {formatPercent(percent, language)}
      </span>
      <span aria-hidden="true" className="max-w-full truncate text-label text-graphite">
        {name}
      </span>
    </li>
  )
}

/** CPU, RAM and the fullest drive, red while they alert. */
export function SystemCard() {
  const t = useT()
  const language = useLanguage()
  const view = useSystem((store) => store.capsule.view)
  const cpu = view?.cpuPercent ?? null
  const ram = view?.ramPercent ?? null
  const storage = view?.storage ?? null
  const cpuAlert = view?.alerts.cpu ?? false
  const ramAlert = view?.alerts.ram ?? false
  const storageAlert = storage?.alert ?? false
  const letter = storage?.letter ?? NO_DRIVE
  const used = storage?.usedPercent ?? null
  return (
    <ul className="mt-2 flex min-h-0 flex-1 items-center justify-between overflow-hidden">
      <Gauge
        name={t('system.card.cpu')}
        percent={cpu}
        alert={cpuAlert}
        label={t(cpuAlert ? 'system.capsule.cpuHigh' : 'system.capsule.cpu', { value: formatPercent(cpu, language) })}
      />
      <Gauge
        name={t('system.card.ram')}
        percent={ram}
        alert={ramAlert}
        label={t(ramAlert ? 'system.capsule.ramHigh' : 'system.capsule.ram', { value: formatPercent(ram, language) })}
      />
      <Gauge
        name={storage ? `${letter}:` : NO_DRIVE}
        percent={used}
        alert={storageAlert}
        label={t(storageAlert ? 'system.capsule.storageLow' : 'system.capsule.storage', { letter, value: formatPercent(used, language) })}
      />
    </ul>
  )
}
