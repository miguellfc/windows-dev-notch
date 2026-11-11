import type { FullSample } from '../../../shared/system/schema'
import { useLanguage, useT } from '../../shared/use-t'
import { formatBytes, formatPercent } from './format'

/**
 * One line per drive ("C: 62 % · 120 GB libres · actividad 3 %"), side by side while they fit.
 * `disks` is undefined while only light samples have arrived: a quiet placeholder line holds the
 * space so nothing jumps when the first full sample lands.
 */
export function DiskList({ disks }: { disks: FullSample['disks'] | undefined }) {
  const t = useT()
  const language = useLanguage()

  if (!disks)
    return (
      <div data-testid="system-disks-loading" className="flex h-4 shrink-0 items-center px-1">
        <span className="sr-only">{t('system.disks.loading')}</span>
        <span aria-hidden="true" className="h-1.5 w-48 rounded-full bg-veil-tile" />
      </div>
    )
  if (disks.length === 0) return null

  return (
    <ul data-testid="system-disks" aria-label={t('system.disks.label')} className="flex shrink-0 flex-wrap gap-x-5 gap-y-0.5 px-1">
      {disks.map((disk) => (
        <li key={disk.letter} data-testid="system-disk" className="tabular whitespace-nowrap text-label leading-4 text-graphite">
          {t('system.disks.line', {
            letter: disk.letter,
            used: formatPercent(disk.usedPercent, language),
            free: formatBytes(disk.freeBytes, language),
            activity: formatPercent(disk.activityPercent, language),
          })}
        </li>
      ))}
    </ul>
  )
}
