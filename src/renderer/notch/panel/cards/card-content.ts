import type { ClaudeSession } from '../../../../shared/claude/types'
import { orderSessions, relativeAgo } from '../../../../shared/claude/view'
import type { ContributionsResult, PlatformStatus } from '../../../../shared/code-review/schema'
import type { GmailMessage, GmailState } from '../../../../shared/gmail/schema'
import type { MessageKey, MessageParams } from '../../../../shared/i18n/messages'
import type { Note } from '../../../../shared/notes/schema'
import type { RedmineState } from '../../../../shared/redmine/schema'
import { contributionsPhase } from '../../../shared/code-review/contributions-format'

/** The sessions a card has room for: attention first. */
export function topSessions(sessions: readonly ClaudeSession[], limit = 2): ClaudeSession[] {
  return orderSessions(sessions).slice(0, limit)
}

/**
 * "espera respuesta · 2 min" / "trabajando · 14 min". The panel's clock ticks once a minute, so under
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

/**
 * The notice that takes the Redmine card's place; null with hours to show, today's or the month's
 * (offline keeps the last ones; after midnight the month's stay until the next reading).
 */
export function redmineNotice(state: RedmineState | null): MessageKey | null {
  if (state?.status === 'unconfigured') return 'redmine.state.unconfigured'
  if (state?.status === 'auth-error') return 'redmine.state.auth'
  if (state && (state.todayHours !== null || state.monthHours !== null)) return null
  return state?.status === 'offline' ? 'redmine.view.offline' : 'panel.card.loading'
}

/** The notice that takes a contributions card's place; null with a month to show (offline keeps the last one). */
export function contributionsNotice(status: PlatformStatus | undefined, result: ContributionsResult | undefined): MessageKey | null {
  if (status === 'unconfigured') return 'codeReview.state.unconfigured'
  if (status === 'auth-error') return 'codeReview.state.auth'
  const { phase } = contributionsPhase(result)
  if (phase === 'ready') return null
  if (status === 'offline') return 'codeReview.view.offline'
  return phase === 'error' ? 'codeReview.contrib.error' : 'codeReview.contrib.loading'
}

/**
 * The unread count beside the Gmail card's title: the latest reading of a live session, or null.
 * Not the capsule's latch, which holds the last count for a few readings to keep its width.
 */
export function gmailUnreadFigure(state: GmailState | null): number | null {
  if (state?.status !== 'ok' && state?.status !== 'offline') return null
  return state.unread !== null && state.unread > 0 ? state.unread : null
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
