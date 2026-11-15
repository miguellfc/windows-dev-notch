import type { FullSample } from '../../../shared/system/schema'
import { useLanguage, useT } from '../../shared/use-t'
import { USED_MARK, splitAtUsedMark } from './disk-line'
import { formatBytes, formatPercent } from './format'

/**
 * One line per drive ("C: 62 % · 120 GB libres · actividad 3 %"), side by side while they fit.
 * `disks` is undefined while only light samples have arrived: a quiet placeholder line holds the
 * space so nothing jumps when the first full sample lands.
 */
export function DiskList({ disks, alertLetter }: { disks: FullSample['disks'] | undefined; alertLetter?: string | undefined }) {
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
          <DiskLine
            text={t('system.disks.line', {
              letter: disk.letter,
              used: alertLetter === disk.letter ? USED_MARK : formatPercent(disk.usedPercent, language),
              free: formatBytes(disk.freeBytes, language),
              activity: formatPercent(disk.activityPercent, language),
            })}
            used={formatPercent(disk.usedPercent, language)}
            alert={alertLetter === disk.letter}
            low={t('system.disks.low')}
          />
        </li>
      ))}
    </ul>
  )
}

/** A drive below its free-space threshold shows its used figure in red, and says "low" to screen readers. */
function DiskLine({ text, used, alert, low }: { text: string; used: string; alert: boolean; low: string }) {
  if (!alert) return <>{text}</>
  const [before, after] = splitAtUsedMark(text)
  return (
    <>
      {before}
      <span className="text-fail">{used}</span>
      {after}
      <span className="sr-only">, {low}</span>
    </>
  )
}
