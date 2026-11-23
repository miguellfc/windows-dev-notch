import type { RedmineStatus } from '../../../shared/redmine/schema'
import type { IntegrationsSettings } from '../../../shared/settings/schema'

/** The Redmine issue pinned for quick access; session-only, never persisted. */
export interface PinnedIssue {
  readonly id: number
  readonly subject: string
}

/** Pins `issue`, or unpins it when it already is the pinned one; pinning another replaces the previous. */
export function togglePin(pinned: PinnedIssue | null, issue: PinnedIssue): PinnedIssue | null {
  return issue.id === pinned?.id ? null : issue
}

/** Refreshes the pinned subject after a fresh read of the issue; the same object when nothing changes (no re-render). */
export function withSubject(pinned: PinnedIssue | null, id: number, subject: string): PinnedIssue | null {
  return pinned === null || pinned.id !== id || pinned.subject === subject ? pinned : { id, subject }
}

/**
 * Whether the header shortcut to the pinned issue shows: a live Redmine session with the integration
 * on, and not while that same issue is already open.
 */
export function shortcutShown(
  pinned: PinnedIssue | null,
  status: RedmineStatus | undefined,
  integrations: IntegrationsSettings | null,
  currentId?: number | null,
): boolean {
  return (
    pinned !== null &&
    (status === 'ok' || status === 'offline') &&
    integrations !== null &&
    integrations.redmine.enabled &&
    currentId !== pinned.id
  )
}
