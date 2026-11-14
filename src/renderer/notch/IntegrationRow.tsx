import { useEffect, useRef, useState } from 'react'
import { Activity, AlarmClock, GitPullRequest, Mail, MessagesSquare, SquareTerminal, StickyNote, type LucideIcon } from 'lucide-react'
import { tiles, type AppTileId, type IntegrationId } from '../../shared/integrations/registry'
import type { MessageKey } from '../../shared/i18n/messages'
import { useAttentionCount } from '../shared/reminders-store'
import { remindersBadgeLabel } from '../shared/reminders/format'
import { useLanguage, useT } from '../shared/use-t'

const icons: Readonly<Record<IntegrationId | AppTileId, LucideIcon>> = {
  terminal: SquareTerminal,
  claude: MessagesSquare,
  reminders: AlarmClock,
  system: Activity,
  notes: StickyNote,
  gmail: Mail,
  reviews: GitPullRequest,
}

const FAILURE_VISIBLE_MS = 4_000

/** One tile per integration: views open a mini tool inside the notch, apps launch the real app. */
export function IntegrationRow() {
  const t = useT()
  const language = useLanguage()
  const remindersDue = useAttentionCount()
  const [failed, setFailed] = useState<MessageKey | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const openApp = async (app: AppTileId, labelKey: MessageKey) => {
    const result = await window.notch.apps.open({ app })
    if (result.ok && result.data.ok) return
    clearTimeout(timer.current)
    setFailed(labelKey)
    timer.current = setTimeout(() => setFailed(null), FAILURE_VISIBLE_MS)
  }

  // Seven tiles share the 414 px row (440 px panel, px-1): flex-1 over each tile's own content, px-1 inside
  // each tile (4 px + 1 px border per side) and 4 px gaps. A tile never shrinks below its label, so the
  // row only fits when the natural widths add up: measured with the 11 px label font, the labels are
  // 310 px in ES (Terminal 44, Recordatorios 72, Sistema 42, Notas 31, Gmail 29, Revisiones 56,
  // Claude 36) and 277 px in EN (Reminders 55, System 39, Reviews 43) plus 10 px per tile and 24 px of
  // gaps = 404 px ES / 371 px EN of the 414 px (the previous 8 px gaps and px-1.5 needed 456 / 423 px
  // and overflowed). Tiles stay 60 px tall and at least 43 px wide. app.spec checks that no label is
  // cut in either language. The failure line is absolutely positioned above the row so it never
  // changes the panel's height (fixed per session count in EXPANDED_HEIGHTS).
  return (
    <section aria-label={t('notch.integrations.label')} className="relative flex w-full shrink-0 gap-1 px-1">
      {tiles.map((tile) => {
        const Icon = icons[tile.id]
        const badge = tile.id === 'reminders' && remindersDue > 0 ? remindersDue : 0
        const label = t(tile.labelKey)
        return (
          <button
            key={tile.id}
            type="button"
            data-testid={`integration-${tile.id}`}
            aria-label={badge > 0 ? `${label}, ${remindersBadgeLabel(badge, language)}` : undefined}
            onClick={() => {
              if (tile.kind === 'view') void window.notch.notch.openIntegration({ id: tile.id })
              else void openApp(tile.id, tile.labelKey)
            }}
            className="relative flex h-[60px] flex-1 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-tile border border-line bg-veil-tile px-1 text-chalk transition-colors duration-150 hover:bg-veil-hover"
          >
            <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
            <span className="max-w-full truncate text-label font-medium">{label}</span>
            {badge > 0 && (
              <span
                data-testid={`integration-${tile.id}-badge`}
                aria-hidden="true"
                className="tabular absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-wait px-1 text-label font-medium leading-none text-on-wait"
              >
                {badge > 99 ? '99+' : badge}
              </span>
            )}
          </button>
        )
      })}
      {/* Always mounted (empty until a failure) so screen readers announce the text when it is filled. */}
      <p
        role="status"
        data-testid="apps-open-failed"
        className="pointer-events-none absolute inset-x-0 bottom-full px-2 pb-px text-label leading-none text-graphite"
      >
        {failed !== null ? t('apps.openFailed', { app: t(failed) }) : ''}
      </p>
    </section>
  )
}
