import { Check, CircleAlert, Hourglass, Loader, Minus, X, type LucideIcon } from 'lucide-react'
import type { ClaudeSessionStatus } from '../../../shared/claude/types'
import { formatAgo } from '../../../shared/claude/view'
import { useClock } from '../../shared/use-clock'
import { useClaude } from '../../shared/claude-store'
import { locale, useLanguage, useT } from '../../shared/use-t'
import { DOT_COLOR } from './StatusDots'

const ICONS: Readonly<Record<ClaudeSessionStatus, LucideIcon>> = {
  working: Loader,
  waiting: Hourglass,
  done: Check,
  error: CircleAlert,
  idle: Minus,
}

/** "Claude Code" block of the home panel; absent when there are no sessions. Sits beside the integration tiles: 2 rows visible, scrolls for more. */
export function SessionsSection() {
  const t = useT()
  const language = useLanguage()
  const now = useClock()
  const sessions = useClaude((store) => store.state?.sessions)
  if (!sessions || sessions.length === 0) return null
  const ordered = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <section aria-label={t('claude.section.title')} data-testid="claude-sessions" className="min-w-0 flex-1">
      <h2 className="px-2 text-label font-medium leading-[14px] text-graphite">{t('claude.section.title')}</h2>
      <ul className="mt-0.5 max-h-[44px] overflow-y-auto">
        {ordered.map((session) => {
          const Icon = ICONS[session.status]
          return (
            <li key={session.id} className="flex h-[22px] items-center rounded-control hover:bg-veil-tile">
              <button
                type="button"
                data-testid={`claude-session-${session.id}`}
                aria-label={t('claude.session.focus', { name: session.name })}
                onClick={() => void window.notch.claude.focusApp()}
                className="flex h-[22px] min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-control px-2 text-left"
              >
                <span className="min-w-0 flex-1 truncate text-small text-chalk">{session.name}</span>
                <span
                  className="flex shrink-0 items-center gap-1 text-label"
                  style={{ color: DOT_COLOR[session.status] }}
                >
                  <Icon size={12} strokeWidth={2} aria-hidden="true" />
                  {t(`claude.status.${session.status}`)}
                </span>
                <span className="w-[64px] shrink-0 truncate text-right text-label text-graphite">
                  {formatAgo(session.updatedAt, now.getTime(), locale(language))}
                </span>
              </button>
              {session.status === 'idle' ? (
                <button
                  type="button"
                  aria-label={t('claude.session.dismiss', { name: session.name })}
                  onClick={() => void window.notch.claude.dismissSession({ sessionId: session.id })}
                  className="flex size-[22px] shrink-0 cursor-pointer items-center justify-center rounded-control text-graphite hover:bg-veil-tile hover:text-chalk"
                >
                  <X size={14} strokeWidth={1.8} aria-hidden="true" />
                </button>
              ) : (
                <span className="size-[22px] shrink-0" aria-hidden="true" />
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
