import type { MessageKey, MessageParams } from '../../../shared/i18n/messages'
import type { Language } from '../../../shared/settings/schema'
import type { WorkLogEntryView } from '../../../shared/work-log/schema'
import { locale } from '../locale'

/** Whether the entry's clock still runs (or is paused by idleness): its figures move with time. */
export function isLiveEntry(entry: WorkLogEntryView): boolean {
  return entry.status === 'running' || entry.status === 'paused'
}

/** "20/11" in the app's language (day and month, two digits each). */
function shortDate(at: number, language: Language): string {
  return new Intl.DateTimeFormat(locale(language), { day: '2-digit', month: '2-digit' }).format(at)
}

/** "20/11", or "20/11 – 21/11" when it ended on another day; a live entry has only its start. */
export function workLogDates(entry: WorkLogEntryView, language: Language): string {
  const start = shortDate(entry.startedAt, language)
  if (isLiveEntry(entry) || entry.endedAt === null) return start
  const end = shortDate(entry.endedAt, language)
  return end === start ? start : `${start} – ${end}`
}

/** "8 de 14 hechas" once summarized; before that, the project (the session's folder). */
export function workLogProgress(entry: WorkLogEntryView, t: (key: MessageKey, params?: MessageParams) => string): string {
  if (entry.subtasks.length === 0) return entry.project
  const done = entry.subtasks.filter((subtask) => subtask.status === 'done').length
  return t('workLog.view.progress', { done, count: entry.subtasks.length })
}

/** The status pill: running, paused and summarizing say so; an ended entry says whether it is invoiced, or that it has no summary. */
export function workLogStatusKey(entry: WorkLogEntryView): MessageKey {
  if (entry.status === 'running' || entry.status === 'paused' || entry.status === 'summarizing') return `workLog.status.${entry.status}`
  if (entry.invoiced) return 'workLog.status.invoiced'
  return entry.status === 'unsummarized' ? 'workLog.status.unsummarized' : 'workLog.status.uninvoiced'
}

/** The running or paused entry the capsule and the card follow: the one with the latest event; null without one. */
export function liveWorkLogEntry(entries: readonly WorkLogEntryView[]): WorkLogEntryView | null {
  let latest: WorkLogEntryView | null = null
  for (const entry of entries) {
    if (!isLiveEntry(entry) || entry.live === null) continue
    if (latest === null || latest.live === null || entry.live.lastEventAt > latest.live.lastEventAt) latest = entry
  }
  return latest
}

/** Entries not invoiced yet that are done measuring (the card's count). */
export function uninvoicedCount(entries: readonly WorkLogEntryView[]): number {
  return entries.filter((entry) => !entry.invoiced && !isLiveEntry(entry)).length
}
