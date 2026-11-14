import type { ClaudeSession, ClaudeSessionStatus, PendingPermission } from './types'

/** A `done` session keeps its green dot only this long after it became done. */
export const DONE_VISIBLE_MS = 8000
export const MAX_DOTS = 4

export type DotStatus = Exclude<ClaudeSessionStatus, 'idle'>

/** Attention first: what needs the user comes before what is merely running. */
const DOT_ORDER: Readonly<Record<DotStatus, number>> = { waiting: 0, error: 1, working: 2, done: 3 }

/** Row order of the panel: attention first (waiting, error, working, done, idle), newest first within each. */
const ROW_ORDER: Readonly<Record<ClaudeSessionStatus, number>> = { ...DOT_ORDER, idle: 4 }

export function orderSessions(sessions: readonly ClaudeSession[]): ClaudeSession[] {
  return [...sessions].sort((a, b) => ROW_ORDER[a.status] - ROW_ORDER[b.status] || b.updatedAt - a.updatedAt)
}

/** The status a session shows as a dot, or null when it has none (idle, or done for too long). */
export function dotStatus(session: ClaudeSession, now: number): DotStatus | null {
  if (session.status === 'idle') return null
  if (session.status === 'done' && now - session.updatedAt >= DONE_VISIBLE_MS) return null
  return session.status
}

export interface DotSummary {
  dots: DotStatus[]
  /** Sessions that have a dot but did not fit in `MAX_DOTS`. */
  extra: number
  counts: Record<DotStatus, number>
}

export function summarizeDots(sessions: readonly ClaudeSession[], now: number): DotSummary {
  const counts: Record<DotStatus, number> = { working: 0, waiting: 0, done: 0, error: 0 }
  const all: DotStatus[] = []
  for (const session of sessions) {
    const status = dotStatus(session, now)
    if (!status) continue
    counts[status] += 1
    all.push(status)
  }
  all.sort((a, b) => DOT_ORDER[a] - DOT_ORDER[b])
  return { dots: all.slice(0, MAX_DOTS), extra: Math.max(0, all.length - MAX_DOTS), counts }
}

/** Milliseconds until the next visible `done` dot turns off, or null when none will. */
export function nextDoneExpiry(sessions: readonly ClaudeSession[], now: number): number | null {
  let soonest: number | null = null
  for (const session of sessions) {
    if (dotStatus(session, now) !== 'done') continue
    const remaining = session.updatedAt + DONE_VISIBLE_MS - now
    if (soonest === null || remaining < soonest) soonest = remaining
  }
  return soonest
}

export type RelativeUnit = 'second' | 'minute' | 'hour' | 'day'

/** Coarse "how long ago" for a session row: always whole units, never in the future. */
export function relativeAgo(updatedAt: number, now: number): { value: number; unit: RelativeUnit } {
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1000))
  if (seconds < 60) return { value: seconds, unit: 'second' }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return { value: minutes, unit: 'minute' }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { value: hours, unit: 'hour' }
  return { value: Math.floor(hours / 24), unit: 'day' }
}

export function formatAgo(updatedAt: number, now: number, locale: string): string {
  const { value, unit } = relativeAgo(updatedAt, now)
  return new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'short' }).format(-value, unit)
}

/** Allow needs the whole action on screen: a cut preview can only be denied here (or decided in Claude). */
export function canAllow(pending: PendingPermission): boolean {
  return !pending.previewTruncated
}

/** Characters of the preview that the card does not show. */
export function hiddenPreviewChars(pending: PendingPermission): number {
  return Math.max(0, pending.previewLength - pending.preview.length)
}

export interface PermissionCardState {
  /** Request whose settle delay has elapsed; any other request is still settling. */
  settledId: string | null
  /** Request whose decision was sent and has not been confirmed or failed yet. */
  submittedId: string | null
}

/**
 * Which decision buttons are enabled. Derived from ids (not a boolean reset by an
 * effect) so a newly shown request never gets a committed frame with enabled buttons.
 */
export function permissionButtons(request: PendingPermission, card: PermissionCardState): { deny: boolean; allow: boolean } {
  const ready = card.settledId === request.id && card.submittedId !== request.id
  return { deny: ready, allow: ready && canAllow(request) }
}
