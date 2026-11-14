import { ArrowLeft } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ProcessOrder, SystemMetrics } from '../../../shared/system/schema'
import { useSystem } from '../../shared/system-store'
import { useT } from '../../shared/use-t'
import { Segmented } from '../../ui/Segmented'
import { headerIconButton } from '../reminders/styles'
import { DiskList } from './DiskList'
import { pushHistory } from './history'
import { MetricCards, ramPercent } from './MetricCards'
import { ProcessList } from './ProcessList'

/**
 * Esc anywhere in the view goes back to the integrations row instead of closing the notch. A row
 * asking to confirm a close handles its own Esc first (cancel) and stops propagation. React's
 * stopPropagation also stops the native bubble, so NotchApp's window-level Esc dismiss never sees it.
 */
const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  void window.notch.notch.back()
}

interface History {
  /** The sample last added, so each one is added once. */
  sample: SystemMetrics | null
  cpu: number[]
  ram: number[]
}

const addSample = (history: History, sample: SystemMetrics | null): History => {
  if (!sample || sample.kind === 'unavailable') return { ...history, sample }
  return {
    sample,
    cpu: pushHistory(history.cpu, sample.cpuPercent),
    ram: pushHistory(history.ram, ramPercent(sample)),
  }
}

/** The last minute of CPU and RAM, kept while the view is open (it starts over on every visit). */
function useHistory(metrics: SystemMetrics | null): History {
  // The sample already in the store at mount may be a light one from seconds ago: it is marked as
  // seen, not drawn, so the line starts with the view's own samples.
  const [history, setHistory] = useState<History>(() => ({ sample: metrics, cpu: [], ram: [] }))
  // Adjusted during render (React's "storing information from previous renders"): no extra commit
  // with a stale line, and no effect that sets state.
  if (history.sample !== metrics) {
    const next = addSample(history, metrics)
    setHistory(next)
    return next
  }
  return history
}

/** The System mini tool: live metrics, disks and the top processes with confirm-to-close. */
export function SystemView() {
  const t = useT()
  const metrics = useSystem((state) => state.metrics)
  const [order, setOrder] = useState<ProcessOrder>('cpu')
  const history = useHistory(metrics)
  const panel = useRef<HTMLDivElement>(null)

  // Main samples the view for as long as the mode is 'system'; the view only tells it the order.
  // On unmount the list is dropped: the next visit must not show a stale top list until its first tick.
  useEffect(() => () => useSystem.setState({ processes: [] }), [])
  useEffect(() => {
    void window.notch.system.view({ by: order })
  }, [order])

  // The tile that opened the view unmounts: keep focus in the panel so the keyboard, and the
  // panel's Esc, keep working.
  useEffect(() => panel.current?.focus(), [])

  const unavailable = metrics?.kind === 'unavailable'
  const sample = metrics && metrics.kind !== 'unavailable' ? metrics : null
  const full = metrics?.kind === 'full' ? metrics : undefined

  return (
    // Focusable (not tabbable): a click on a blank area keeps focus in the panel, so Esc reaches
    // onPanelKeyDown (back to the row) instead of NotchApp's window-level dismiss.
    <div
      ref={panel}
      data-testid="system-panel"
      tabIndex={-1}
      onKeyDown={onPanelKeyDown}
      className="flex h-full flex-col gap-2 px-3 pb-3 pt-2 outline-none"
    >
      <header className="flex h-9 shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => void window.notch.notch.back()}
          aria-label={t('system.view.back')}
          title={t('system.view.back')}
          className={headerIconButton}
        >
          <ArrowLeft size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <h2 className="ml-2 text-body font-medium text-chalk">{t('integration.system')}</h2>
        {!unavailable && (
          <div className="ml-auto">
            <Segmented
              label={t('system.view.order')}
              value={order}
              options={[
                { value: 'cpu', label: t('system.card.cpu') },
                { value: 'ram', label: t('system.card.ram') },
              ]}
              onChange={setOrder}
            />
          </div>
        )}
      </header>
      {unavailable ? (
        <div data-testid="system-unavailable" className="flex flex-1 flex-col items-center justify-center gap-1 pb-8 text-center">
          <p className="text-body text-chalk">{t('system.view.unavailable')}</p>
          <p className="text-small text-graphite">{t('system.view.unavailableHint')}</p>
        </div>
      ) : (
        <>
          <MetricCards sample={sample} network={full?.network} cpuHistory={history.cpu} ramHistory={history.ram} />
          <DiskList disks={full?.disks} alertLetter={sample?.alerts.disk?.letter} />
          <ProcessList order={order} onFocusLost={() => panel.current?.focus()} />
        </>
      )}
    </div>
  )
}
