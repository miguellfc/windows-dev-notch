import type { ClaudeSession } from '../../../../shared/claude/types'
import { orderSessions, relativeAgo } from '../../../../shared/claude/view'
import type { GmailMessage, GmailState } from '../../../../shared/gmail/schema'
import type { MessageKey, MessageParams } from '../../../../shared/i18n/messages'
import type { Note } from '../../../../shared/notes/schema'

/** The sessions a card has room for: attention first. */
export function topSessions(sessions: readonly ClaudeSession[], limit = 2): ClaudeSession[] {
  return orderSessions(sessions).slice(0, limit)
}

/**
 * "espera permiso · 2 min" / "trabajando · 14 min". The panel's clock ticks once a minute, so under
 * a minute it says "ahora" rather than a count of seconds that would stand still.
 */
export function sessionLine(
  session: ClaudeSession,
  now: number,
  locale: string,
  t: (key: MessageKey, params?: MessageParams) => string,
): string {
  const { value, unit } = relativeAgo(session.updatedAt, now)
  const elapsed =
    unit === 'second' ? t('notes.time.now') : new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short' }).format(value)
  return `${t(`panel.card.session.${session.status}`)} · ${elapsed}`
}

/** The notes a card has room for: pinned first, then the latest edited. */
export function topNotes(notes: readonly Note[], limit = 3): Note[] {
  return [...notes]
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, limit)
}

/** How much of the daily target is logged, from 0 to 1. */
export function redmineProgress(hours: number | null, target: number): number {
  if (hours === null || target <= 0) return 0
  return Math.min(Math.max(hours / target, 0), 1)
}

export type GmailCardBody = 'loading' | 'list' | 'empty' | 'offline' | 'unconfigured' | 'signed-out' | 'signing-in' | 'expired'

/**
 * What the Gmail card shows. An empty list only means an empty mailbox when the count agrees: the
 * list may not have been read yet while the count already says there is unread mail.
 */
export function gmailCardBody(state: GmailState | null, recent: readonly GmailMessage[] | null): GmailCardBody {
  if (!state) return 'loading'
  if (state.status !== 'ok' && state.status !== 'offline') return state.status
  if (recent !== null && recent.length > 0) return 'list'
  if (state.status === 'offline') return 'offline'
  return recent !== null && state.unread === 0 ? 'empty' : 'loading'
}
