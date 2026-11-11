import { Check, ChevronDown, CircleAlert, Hourglass, Loader, Minus, X, type LucideIcon } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import type { ClaudeSessionStatus } from '../../../shared/claude/types'
import { formatAgo, orderSessions } from '../../../shared/claude/view'
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

/**
 * "Claude Code" block of the home panel; absent when there are no sessions. Sits beside the
 * integration tiles: two rows visible, attention first, the rest one wheel tick or Tab away
 * (the list snaps by row and the heading says how many are below).
 */
export function SessionsSection() {
  const t = useT()
  const language = useLanguage()
  const now = useClock()
  const sessions = useClaude((store) => store.state?.sessions)
  const list = useRef<HTMLUListElement>(null)
  const [hiddenBelow, setHiddenBelow] = useState(0)

  // Rows that start at or below the list's visible bottom. Compared in screen space, so the
  // morph's scale (the list renders while the capsule grows) does not change the answer.
  const measure = () => {
    const element = list.current
    if (!element) return setHiddenBelow(0)
    const bottom = element.getBoundingClientRect().bottom
    const below = [...element.children].filter((row) => row.getBoundingClientRect().top >= bottom - 1).length
    setHiddenBelow(below)
  }
  useLayoutEffect(measure)

  if (!sessions || sessions.length === 0) return null
  const ordered = orderSessions(sessions)
  // The dismiss column only exists while some session can be dismissed, so names get the room.
  const dismissable = ordered.some((session) => session.status === 'idle')

  return (
    <section aria-label={t('claude.section.title')} data-testid="claude-sessions" className="min-w-0 flex-1">
      <h2 className="flex h-3 items-center justify-between px-2 text-label font-medium leading-3 text-graphite">
        <span>{t('claude.section.title')}</span>
        {hiddenBelow > 0 && (
          <span data-testid="claude-sessions-more" aria-hidden="true" className="tabular flex items-center gap-0.5">
            +{hiddenBelow}
            <ChevronDown size={11} strokeWidth={2} />
          </span>
        )}
      </h2>
      {/* Rows are 24 px (WCAG 2.5.8 minimum target): two fit beside the 60 px tiles. */}
      <ul ref={list} onScroll={measure} className="max-h-12 snap-y snap-mandatory overflow-y-auto">
        {ordered.map((session) => {
          const Icon = ICONS[session.status]
          const status = t(`claude.status.${session.status}`)
          const ago = formatAgo(session.updatedAt, now.getTime(), locale(language))
          return (
            <li key={session.id} className="flex h-6 snap-start items-center rounded-control hover:bg-veil-tile">
              <button
                type="button"
                data-testid={`claude-session-${session.id}`}
                aria-label={`${t('claude.session.focus', { name: session.name })}, ${status}, ${ago}`}
                title={`${session.name} · ${status} · ${ago}`}
                onClick={() => void window.notch.claude.focusApp()}
                className="flex h-6 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-control px-2 text-left focus-inset"
              >
                <Icon
                  size={12}
                  strokeWidth={2}
                  aria-hidden="true"
                  className="shrink-0"
                  style={{ color: DOT_COLOR[session.status] }}
                />
                <span className="min-w-0 flex-1 truncate text-small text-chalk">{session.name}</span>
                <span className="tabular shrink-0 whitespace-nowrap text-label text-graphite">{ago}</span>
              </button>
              {session.status === 'idle' ? (
                <button
                  type="button"
                  aria-label={t('claude.session.dismiss', { name: session.name })}
                  title={t('claude.session.dismiss', { name: session.name })}
                  onClick={() => void window.notch.claude.dismissSession({ sessionId: session.id })}
                  className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-control text-graphite hover:bg-veil-tile hover:text-chalk focus-inset"
                >
                  <X size={14} strokeWidth={1.8} aria-hidden="true" />
                </button>
              ) : (
                dismissable && <span className="size-6 shrink-0" aria-hidden="true" />
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
