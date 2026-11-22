import { Check, ChevronLeft, Circle } from 'lucide-react'
import { useEffect, useRef, useState, type Ref } from 'react'
import type { MessageKey } from '../../../shared/i18n/messages'
import type { Result } from '../../../shared/ipc/result'
import { durationText } from '../../../shared/work-log/duration'
import type { WorkLogEntryView, WorkLogSubtaskView } from '../../../shared/work-log/schema'
import { liveTotalMs } from '../../shared/work-log-store'
import { isLiveEntry, workLogDates } from '../../shared/work-log/format'
import { useLanguage, useT } from '../../shared/use-t'
import { headerIconButton, primaryButton, secondaryButton } from '../reminders/styles'
import { StatusPill } from './WorkLogList'

/** How long "Copiado" stays after a copy. */
export const COPIED_MS = 1500

export type DetailActionKey = 'copy' | 'close' | 'retry' | 'invoice' | 'uninvoice' | 'delete'

export interface DetailAction {
  key: DetailActionKey
  label: MessageKey
  primary: boolean
  run: () => Promise<Result<null>>
}

/**
 * The detail's buttons, in order: Copiar (primary) always; Cerrar y resumir while paused, Reintentar
 * without a summary; once measuring is over, Marcar / Quitar imputada and Borrar.
 */
export function detailActions(entry: WorkLogEntryView): DetailAction[] {
  const sessionId = entry.sessionId
  const api = () => window.notch.workLog
  const actions: DetailAction[] = [{ key: 'copy', label: 'workLog.action.copy', primary: true, run: () => api().copy({ sessionId }) }]
  if (entry.status === 'paused') actions.push({ key: 'close', label: 'workLog.action.close', primary: false, run: () => api().summarize({ sessionId }) })
  if (entry.status === 'unsummarized') actions.push({ key: 'retry', label: 'workLog.action.retry', primary: false, run: () => api().summarize({ sessionId }) })
  if (!isLiveEntry(entry)) {
    actions.push(
      entry.invoiced
        ? { key: 'uninvoice', label: 'workLog.action.uninvoice', primary: false, run: () => api().setInvoiced({ sessionId, invoiced: false }) }
        : { key: 'invoice', label: 'workLog.action.invoice', primary: false, run: () => api().setInvoiced({ sessionId, invoiced: true }) },
      { key: 'delete', label: 'workLog.action.delete', primary: false, run: () => api().delete({ sessionId }) },
    )
  }
  return actions
}

/** One of the two big figures: "Claude" or "Total" over the time in Jersey 10. */
function Stat({ label, ms, testId }: { label: string; ms: number; testId: string }) {
  return (
    <div className="card flex min-w-0 flex-1 flex-col px-3 py-2">
      <span className="text-label text-graphite">{label}</span>
      <span data-testid={testId} className="digits whitespace-nowrap text-digits-lg leading-none text-chalk">
        {durationText(ms)}
      </span>
    </div>
  )
}

function SubtaskRow({
  subtask,
  index,
  copied,
  onCopy,
}: {
  subtask: WorkLogSubtaskView
  index: number
  copied: boolean
  onCopy: () => void
}) {
  const t = useT()
  const done = subtask.status === 'done'
  return (
    <li className="border-t border-line first:border-t-0">
      <button
        type="button"
        data-testid="work-log-subtask"
        data-status={subtask.status}
        onClick={onCopy}
        aria-label={`${t('workLog.view.copySubtask', { number: index + 1 })}: ${subtask.title}`}
        className="focus-inset grid w-full cursor-pointer grid-cols-[18px_1fr_auto] items-start gap-2 rounded-tile px-2 py-1.5 text-left text-small transition-colors duration-150 hover:bg-veil-tile focus-visible:bg-veil-tile"
      >
        <span className="tabular pt-px text-label text-graphite">{index + 1}</span>
        <span className={`flex min-w-0 items-start gap-1.5 ${done ? 'text-chalk' : 'text-graphite'}`}>
          {done ? (
            <Check size={12} strokeWidth={2.2} aria-hidden="true" className="mt-[3px] shrink-0 text-ok" />
          ) : (
            <Circle size={11} strokeWidth={2} aria-hidden="true" className="mt-[3px] shrink-0 text-graphite" />
          )}
          {/* The subtask comes from the summary: plain text, React escapes it. */}
          <span className="min-w-0 break-words">{subtask.title}</span>
        </span>
        <span className="tabular whitespace-nowrap pt-px text-label text-graphite">
          {copied ? (
            <span data-testid="work-log-subtask-copied" className="font-semibold text-[color:var(--int)]">
              {t('workLog.view.copied')}
            </span>
          ) : done ? (
            <>
              <b className="font-semibold text-chalk">{durationText(subtask.claudeMs ?? 0)}</b> · {durationText(subtask.totalMs ?? 0)}
            </>
          ) : (
            t('workLog.view.pending')
          )}
        </span>
      </button>
    </li>
  )
}

/**
 * One session at full view: `‹` and its title, the dates and folder with its pill, the two big
 * figures (Claude and Total, live while it runs), the numbered subtasks (a click copies one, "Copiado"
 * for 1.5 s) and the actions (see {@link detailActions}). A failed action says so under the buttons;
 * a delete goes back to the list, which offers Undo.
 */
export function WorkLogDetail({
  entry,
  now,
  idlePauseMs,
  onBack,
  onDeleted,
  ref,
}: {
  entry: WorkLogEntryView
  now: number
  idlePauseMs: number
  onBack: () => void
  onDeleted: (sessionId: string) => void
  ref?: Ref<HTMLDivElement>
}) {
  const t = useT()
  const language = useLanguage()
  // What was just copied: the whole entry or one subtask, for COPIED_MS.
  const [copied, setCopied] = useState<'entry' | number | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  useEffect(() => {
    if (copied === null) return
    const timer = setTimeout(() => setCopied(null), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])

  const perform = async (run: () => Promise<Result<null>>, after: () => void) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setFailed(false)
    try {
      const result = await run()
      if (result.ok) after()
      else setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const onAction = (action: DetailAction) =>
    void perform(action.run, () => {
      if (action.key === 'copy') setCopied('entry')
      if (action.key === 'delete') onDeleted(entry.sessionId)
    })

  const copySubtask = (index: number) =>
    void perform(
      () => window.notch.workLog.copy({ sessionId: entry.sessionId, subtask: index }),
      () => setCopied(index),
    )

  const meta = [workLogDates(entry, language), entry.project].filter((part) => part !== '').join(' · ')

  return (
    <div ref={ref} tabIndex={-1} data-testid="work-log-detail" data-session-id={entry.sessionId} className="flex min-h-0 flex-col gap-2 outline-none">
      <header className="flex h-8 shrink-0 items-center gap-1">
        <button type="button" data-testid="work-log-back" onClick={onBack} aria-label={t('workLog.view.back')} title={t('workLog.view.back')} className={headerIconButton}>
          <ChevronLeft size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <h2 data-testid="work-log-detail-title" title={entry.title} className="ml-1.5 min-w-0 flex-1 truncate text-body font-medium text-chalk">
          {entry.title}
        </h2>
      </header>
      <div className="flex shrink-0 items-center gap-2 px-1">
        <span className="tabular min-w-0 flex-1 truncate text-label text-graphite">{meta}</span>
        <StatusPill entry={entry} />
      </div>
      <div className="flex shrink-0 gap-2">
        <Stat label={t('workLog.view.claude')} ms={entry.claudeMs} testId="work-log-claude" />
        <Stat label={t('workLog.view.total')} ms={liveTotalMs(entry, now, idlePauseMs)} testId="work-log-total" />
      </div>
      {entry.subtasks.length > 0 && (
        <ol data-testid="work-log-subtasks" aria-label={t('workLog.view.subtasks')} className="card flex min-h-0 flex-col overflow-y-auto p-1">
          {entry.subtasks.map((subtask, index) => (
            <SubtaskRow key={index} subtask={subtask} index={index} copied={copied === index} onCopy={() => copySubtask(index)} />
          ))}
        </ol>
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-2 pt-0.5">
        {detailActions(entry).map((action) => (
          <button
            key={action.key}
            type="button"
            data-testid={`work-log-${action.key}`}
            aria-disabled={busy}
            onClick={() => onAction(action)}
            className={action.primary ? primaryButton : secondaryButton}
          >
            {action.key === 'copy' && copied === 'entry' ? t('workLog.view.copied') : t(action.label)}
          </button>
        ))}
      </div>
      <p role="status" data-testid="work-log-detail-status" className="h-4 shrink-0 truncate px-1 text-label text-fail">
        {failed ? t('workLog.view.failed') : ''}
      </p>
    </div>
  )
}
