import { X } from 'lucide-react'
import { useContext, type MouseEvent } from 'react'
import type { ClaudeSession, ClaudeSessionStatus } from '../../../../shared/claude/types'
import { useClaude } from '../../../shared/claude-store'
import { useClock } from '../../../shared/use-clock'
import { locale, useLanguage, useT } from '../../../shared/use-t'
import { DOT_COLOR } from '../../claude/StatusDots'
import { CardTabStop } from '../PanelCard'
import { CardNotice } from './CardNotice'
import { sessionLine, topSessions } from './card-content'

/** Coral and red say the session needs the user; every other state stays quiet. */
const LINE_COLOR: Readonly<Record<ClaudeSessionStatus, string>> = {
  waiting: 'text-wait',
  error: 'text-fail',
  working: 'text-graphite',
  done: 'text-graphite',
  idle: 'text-graphite',
}

/** Dismissing removes the button under the focus, so the focus goes back to the card first. */
function dismiss(event: MouseEvent<HTMLButtonElement>, sessionId: string): void {
  event.currentTarget.closest('[data-card-index]')?.querySelector<HTMLElement>('[data-card-main]')?.focus({ preventScroll: true })
  void window.notch.claude.dismissSession({ sessionId })
}

function SessionRow({ session, now }: { session: ClaudeSession; now: number }) {
  const t = useT()
  const language = useLanguage()
  const isTabStop = useContext(CardTabStop)
  const label = t('claude.session.dismiss', { name: session.name })
  return (
    <li data-testid={`claude-session-${session.id}`} className="flex h-[38px] min-w-0 items-center gap-2">
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: DOT_COLOR[session.status] }} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-small font-medium text-chalk">{session.name}</span>
        <span className={`truncate text-label ${LINE_COLOR[session.status]}`}>{sessionLine(session, now, locale(language), t)}</span>
      </span>
      {session.status === 'idle' && (
        <button
          type="button"
          tabIndex={isTabStop ? 0 : -1}
          aria-label={label}
          title={label}
          onClick={(event) => dismiss(event, session.id)}
          className="focus-inset pointer-events-auto -mr-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-tile text-graphite hover:bg-veil-hover hover:text-chalk"
        >
          <X size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      )}
    </li>
  )
}

/** The two sessions that matter most and how many more there are. */
export function ClaudeCard() {
  const t = useT()
  const now = useClock()
  const sessions = useClaude((store) => store.state?.sessions)
  if (!sessions || sessions.length === 0) return <CardNotice text={t('panel.card.noSessions')} />
  const top = topSessions(sessions)
  const more = sessions.length - top.length
  return (
    <div className="mt-2 flex min-h-0 flex-1 flex-col overflow-hidden">
      <ul className="flex min-w-0 flex-col gap-1.5">
        {top.map((session) => (
          <SessionRow key={session.id} session={session} now={now.getTime()} />
        ))}
      </ul>
      {more > 0 && (
        <span data-testid="claude-sessions-more" className="tabular mt-auto text-label text-graphite">
          +{more}
        </span>
      )}
    </div>
  )
}
