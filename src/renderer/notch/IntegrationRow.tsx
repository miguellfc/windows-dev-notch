import { useEffect, useRef, useState } from 'react'
import { Activity, AlarmClock, SquareTerminal, StickyNote, type LucideIcon } from 'lucide-react'
import { ClaudeMark, GithubMark, GitlabMark, GmailMark, RedmineMark } from '../shared/brand-icons'
import { tiles, type AppTileId, type ReviewTileId } from '../../shared/integrations/registry'
import type { MessageKey } from '../../shared/i18n/messages'
import { setReviewsTarget } from '../shared/code-review-store'
import { useAttentionCount } from '../shared/reminders-store'
import { remindersBadgeLabel } from '../shared/reminders/format'
import { useLanguage, useT } from '../shared/use-t'

const icons: Readonly<Record<(typeof tiles)[number]['id'], LucideIcon>> = {
  terminal: SquareTerminal,
  claude: ClaudeMark,
  reminders: AlarmClock,
  system: Activity,
  notes: StickyNote,
  gmail: GmailMark,
  github: GithubMark,
  gitlab: GitlabMark,
  redmine: RedmineMark,
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

  // GitHub and GitLab are two tiles over one view: the tile says which platform it opens on.
  const openReviews = (platform: ReviewTileId) => {
    setReviewsTarget({ platform })
    void window.notch.notch.openIntegration({ id: 'reviews' })
  }

  const openApp = async (app: AppTileId, labelKey: MessageKey) => {
    const result = await window.notch.apps.open({ app })
    if (result.ok && result.data.ok) return
    clearTimeout(timer.current)
    setFailed(labelKey)
    timer.current = setTimeout(() => setFailed(null), FAILURE_VISIBLE_MS)
  }

  // Nine tiles share the 494 px row (the 520 px panel less its 1 px border and 12 px padding per side; the
  // row has no padding of its own since the ninth tile): flex-1 over each tile's own content, px-1 inside
  // each tile (4 px + 1 px border per side) and 4 px gaps. A tile never shrinks below its label, so the
  // row only fits when the natural widths add up: measured with Playwright at the 11 px label font, the
  // labels are 369 px in ES (Terminal 44, Recordatorios 72, Sistema 42, Notas 31, Gmail 29, GitHub 35,
  // GitLab 34, Redmine 46, Claude 36) and 349 px in EN (Reminders 55, System 39) plus 10 px per tile and
  // 32 px of gaps = 491 px ES / 471 px EN of the 494 px. Tiles stay 60 px tall. app.spec checks that no
  // label is cut and no tile overflows the row in either language. The failure line is absolutely positioned above the row so it never
  // changes the panel's height (fixed per session count in EXPANDED_HEIGHTS).
  return (
    <section aria-label={t('notch.integrations.label')} className="relative flex w-full shrink-0 gap-1">
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
              else if (tile.kind === 'review') openReviews(tile.id)
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
