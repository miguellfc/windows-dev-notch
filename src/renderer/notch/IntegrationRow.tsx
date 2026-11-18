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
  // each tile (4 px + 1 px border = the 5 px of label clearance reminders.spec asks >= 4 of) and 2 px gaps
  // (tiles have no fill of their own, so the gap is invisible; the icon squares stay 10+ px apart). A tile
  // never shrinks below the wider of its label and the 36 px icon square, so the row only fits when those
  // add up: measured in the Tauri e2e at the 11 px Geist label font, ES is Terminal 44, Recordatorios 72,
  // Sistema 42, Redmine 46 and five tiles held at the 36 px square (Notas 31, Gmail 29, GitHub 35, GitLab
  // 34, Claude 36) = 384 px; EN (Reminders 55, System 39) = 364 px. Plus 10 px per tile and 16 px of gaps
  // = 490 px ES / 470 px EN of the 494 px (with 4 px gaps ES was 506 px and overflowed). Tiles stay 60 px
  // tall. app.spec checks that no label is cut and no tile overflows the row in either language. The
  // failure line is absolutely positioned above the row so it never changes the panel's height (fixed per
  // session count in EXPANDED_HEIGHTS).
  return (
    <section aria-label={t('notch.integrations.label')} className="relative flex w-full shrink-0 gap-0.5">
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
            className="group relative flex h-[60px] flex-1 cursor-pointer flex-col items-center justify-center gap-1 rounded-tile border border-transparent px-1 text-graphite transition-colors duration-150 hover:text-chalk focus-visible:text-chalk"
          >
            <span className="relative flex size-9 shrink-0 items-center justify-center rounded-[11px] border border-line bg-veil-tile text-chalk transition-colors duration-150 group-hover:bg-veil-hover group-focus-visible:bg-veil-hover">
              <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
              {badge > 0 && (
                <span
                  data-testid={`integration-${tile.id}-badge`}
                  aria-hidden="true"
                  className="tabular absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-wait px-1 text-label font-semibold leading-none text-on-wait"
                >
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
            </span>
            <span data-testid={`integration-${tile.id}-label`} className="max-w-full truncate text-label font-medium">{label}</span>
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
