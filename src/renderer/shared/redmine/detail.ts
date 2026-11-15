import type { MessageKey } from '../../../shared/i18n/messages'
import type { RedmineIssueDetail, RedmineWriteResult } from '../../../shared/redmine/schema'
import { writeErrorKey } from './format'

/** A refused write as its section shows it: the message, Redmine's own messages, and whether Retry is offered. */
export interface WriteRefusal {
  readonly key: MessageKey
  readonly messages: readonly string[]
  readonly retryable: boolean
}

/** Redmine refusals that may pass on a second try; the others need a change first. */
const RETRYABLE = new Set(['network', 'server', 'invalid-response'])

/**
 * What a write's IPC answer means for the form: null when Redmine accepted it, else the refusal.
 * A failed call (the session changed under it, or main refused the input) is "No se pudo guardar",
 * retryable; a validation refusal shows Redmine's messages when it sends them.
 */
export function writeRefusal(result: { ok: true; data: RedmineWriteResult } | { ok: false }): WriteRefusal | null {
  if (!result.ok) return { key: 'redmine.error.failed', messages: [], retryable: true }
  const answer = result.data
  if (answer.ok) return null
  return {
    key: writeErrorKey(answer.reason),
    messages: answer.reason === 'validation' ? (answer.messages ?? []) : [],
    retryable: RETRYABLE.has(answer.reason),
  }
}

/** The statuses of the select: the allowed ones, with the current status always present (first when Redmine leaves it out). */
export function statusChoices(detail: RedmineIssueDetail): RedmineIssueDetail['allowedStatuses'] {
  return detail.allowedStatuses.some((status) => status.id === detail.status.id) ? detail.allowedStatuses : [detail.status, ...detail.allowedStatuses]
}

/**
 * The status the select shows: the one being written while a write is in flight, else Redmine's
 * own (main's data). A draft never outlives its write, so a status Redmine did not apply never stays.
 */
export function shownStatus(draft: number | null, writing: boolean, current: number | null): number | null {
  return writing && draft !== null ? draft : current
}
