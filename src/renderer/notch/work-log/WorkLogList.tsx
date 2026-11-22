import { ChevronRight } from 'lucide-react'
import type { KeyboardEvent, Ref } from 'react'
import { durationText } from '../../../shared/work-log/duration'
import type { WorkLogEntryView } from '../../../shared/work-log/schema'
import { liveTotalMs } from '../../shared/work-log-store'
import { isLiveEntry, workLogDates, workLogProgress, workLogStatusKey } from '../../shared/work-log/format'
import { useLanguage, useT } from '../../shared/use-t'
import { radioKeyTarget } from '../../ui/roving'

const ROW = '[data-testid="work-log-entry"]'

/** The rows shown, in order. */
export const entryRows = (root: HTMLElement | null): HTMLElement[] => (root ? [...root.querySelectorAll<HTMLElement>(ROW)] : [])

/** The row of one entry, if it is shown. */
export const entryRow = (root: HTMLElement | null, sessionId: string): HTMLElement | null =>
  entryRows(root).find((row) => row.dataset.sessionId === sessionId) ?? null

/** Up/Down (wrapping), Home and End move between rows; Enter is the row's own click. */
const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'Home' && event.key !== 'End') return
  const rows = entryRows(event.currentTarget)
  const from = rows.indexOf(document.activeElement as HTMLElement)
  if (from === -1) return
  const to = radioKeyTarget(event.key, from, rows.length)
  if (to === null) return
  event.preventDefault()
  const row = rows[to]
  row?.focus()
  row?.scrollIntoView({ block: 'nearest' })
}

/** The pill's look per status: the integration's color while it runs, green once invoiced, grey otherwise. */
function pillClass(entry: WorkLogEntryView): string {
  if (entry.status === 'running') return 'bg-[color-mix(in_srgb,var(--int)_14%,transparent)] text-[color:var(--int)]'
  if (entry.invoiced && !isLiveEntry(entry) && entry.status !== 'summarizing') return 'bg-ok/13 text-ok'
  if (entry.status === 'paused' || entry.status === 'unsummarized') return 'bg-veil-tile text-graphite-glass'
  return 'bg-veil-hover text-graphite'
}

/** "en curso", "sin imputar", "imputada"…: always a word, never the color alone. */
export function StatusPill({ entry }: { entry: WorkLogEntryView }) {
  const t = useT()
  return (
    <span data-testid="work-log-status" data-status={entry.status} className={`flex h-5 shrink-0 items-center whitespace-nowrap rounded-full px-2 text-label font-semibold ${pillClass(entry)}`}>
      {t(workLogStatusKey(entry))}
    </span>
  )
}

/** "Claude 3h 10m · Total 5h 45m", the figures in Tiza. */
export function TimesLine({ claudeMs, totalMs }: { claudeMs: number; totalMs: number }) {
  const t = useT()
  return (
    <span data-testid="work-log-times" className="tabular shrink-0 whitespace-nowrap text-label text-graphite">
      {t('workLog.view.claude')} <b className="font-semibold text-chalk">{durationText(claudeMs)}</b>
      {' · '}
      {t('workLog.view.total')} <b className="font-semibold text-chalk">{durationText(totalMs)}</b>
    </span>
  )
}

function Row({ entry, now, idlePauseMs, onOpen }: { entry: WorkLogEntryView; now: number; idlePauseMs: number; onOpen: () => void }) {
  const t = useT()
  const language = useLanguage()
  return (
    <li className="card group relative flex shrink-0">
      <button
        type="button"
        data-testid="work-log-entry"
        data-session-id={entry.sessionId}
        onClick={onOpen}
        title={entry.title}
        className="focus-inset flex w-full min-w-0 cursor-pointer flex-col gap-1 rounded-[inherit] px-3 py-2.5 text-left transition-colors duration-150 group-hover:bg-veil-tile focus-visible:bg-veil-tile"
      >
        {/* Titles and projects come from the session: always plain text, React escapes them. */}
        <span className="flex w-full min-w-0 items-center gap-2 pr-4">
          <span data-testid="work-log-entry-title" className="min-w-0 flex-1 truncate text-body font-medium text-chalk">
            {entry.title}
          </span>
          <StatusPill entry={entry} />
        </span>
        <span className="flex w-full min-w-0 items-center gap-2 pr-4">
          <span className="tabular min-w-0 flex-1 truncate text-label text-graphite">
            {workLogDates(entry, language)} · {workLogProgress(entry, t)}
          </span>
          <TimesLine claudeMs={entry.claudeMs} totalMs={liveTotalMs(entry, now, idlePauseMs)} />
        </span>
      </button>
      <ChevronRight
        size={14}
        strokeWidth={1.8}
        aria-hidden="true"
        className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-graphite opacity-0 transition-opacity duration-150 group-has-[:focus-visible]:opacity-100 group-hover:opacity-100"
      />
    </li>
  )
}

/**
 * Every recorded session as main sorts them (running and paused first, then by end, newest first),
 * each on its own card 8 px apart: title and pill, then the dates with the progress (or the project)
 * and both times. A click or Enter opens the entry's detail; the arrows move between rows. Running
 * totals move with `now`.
 */
export function WorkLogList({
  entries,
  now,
  idlePauseMs,
  onOpen,
  ref,
}: {
  entries: readonly WorkLogEntryView[]
  now: number
  idlePauseMs: number
  onOpen: (sessionId: string) => void
  ref?: Ref<HTMLUListElement>
}) {
  const t = useT()
  return (
    <ul ref={ref} data-testid="work-log-list" aria-label={t('integration.workLog')} onKeyDown={onListKeyDown} className="flex min-h-0 flex-col gap-2 overflow-y-auto">
      {entries.map((entry) => (
        <Row key={entry.sessionId} entry={entry} now={now} idlePauseMs={idlePauseMs} onOpen={() => onOpen(entry.sessionId)} />
      ))}
    </ul>
  )
}
