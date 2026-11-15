import { ExternalLink } from 'lucide-react'
import type { KeyboardEvent, Ref } from 'react'
import type { CodeReviewList, ReviewItem } from '../../../shared/code-review/schema'
import { BADGE_LABEL, BADGE_TEXT, itemBadges, splitRef, type BadgeTone, type ReviewSection } from '../../shared/code-review/format'
import { formatReceived } from '../../shared/gmail/format'
import { useClock } from '../../shared/use-clock'
import { locale, useLanguage, useT } from '../../shared/use-t'
import { radioKeyTarget } from '../../ui/roving'

const ROW = '[data-testid="review-item"]'

/** Rows of both sections, in order (arrows move across the sections). */
export const reviewRows = (root: HTMLElement | null): HTMLElement[] => (root ? [...root.querySelectorAll<HTMLElement>(ROW)] : [])

/** The first row of a section, if it has one. */
export const firstRowOf = (root: HTMLElement | null, section: ReviewSection): HTMLElement | null =>
  root?.querySelector<HTMLElement>(`[data-section="${section}"] ${ROW}`) ?? null

/** Up/Down (wrapping), Home and End move between rows of both sections; Enter is the row's own click. */
const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'Home' && event.key !== 'End') return
  const rows = reviewRows(event.currentTarget)
  const from = rows.indexOf(document.activeElement as HTMLElement)
  if (from === -1) return
  const to = radioKeyTarget(event.key, from, rows.length)
  if (to === null) return
  event.preventDefault()
  const row = rows[to]
  row?.focus()
  row?.scrollIntoView({ block: 'nearest' })
}

const TONES: Readonly<Record<BadgeTone, string>> = {
  neutral: 'text-graphite',
  ok: 'text-ok',
  wait: 'text-wait',
  fail: 'text-fail',
  ice: 'text-ice',
}

function Row({ item, section, now, onOpen }: { item: ReviewItem; section: ReviewSection; now: Date; onOpen: () => void }) {
  const t = useT()
  const language = useLanguage()
  const updated = formatReceived(item.updatedAt, now, language)
  const date = new Date(item.updatedAt)
  const badges = itemBadges(item, section)
  const ref = splitRef(item.ref)
  return (
    <li data-item-id={item.id} className="group relative flex shrink-0">
      <button
        type="button"
        data-testid="review-item"
        onClick={onOpen}
        className="focus-inset flex h-[50px] w-full min-w-0 cursor-pointer flex-col justify-center gap-0.5 rounded-tile px-2.5 text-left transition-colors duration-150 group-hover:bg-veil focus-visible:bg-veil"
      >
        {/* Line 1: the title gets the room, the time stays whole. Refs, titles and authors are
            always plain text: React escapes them. */}
        <span className="flex w-full min-w-0 items-baseline gap-1.5">
          <span data-testid="review-title" className="min-w-0 flex-1 truncate text-body leading-[18px] text-chalk">
            {item.title}
          </span>
          {updated && (
            <time
              dateTime={item.updatedAt}
              title={Number.isNaN(date.getTime()) ? undefined : new Intl.DateTimeFormat(locale(language), { dateStyle: 'medium', timeStyle: 'short' }).format(date)}
              className="tabular shrink-0 text-label leading-4 text-graphite"
            >
              {updated}
            </time>
          )}
        </span>
        {/* Line 2, always one line tall: ref · author · labels. The ref's path and the author give way
            first (higher shrink), the ref's number stays, the labels are never cut. */}
        <span className="flex h-4 w-full min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-label leading-4 text-graphite">
          <span data-testid="review-ref" className="tabular flex min-w-0 shrink-[8] overflow-hidden">
            <span className="min-w-0 truncate">{ref.repo}</span>
            <span className="shrink-0">{ref.number}</span>
          </span>
          {section === 'toReview' && item.author !== '' && (
            <>
              <span aria-hidden="true" className="shrink-0">
                ·
              </span>
              <span className="min-w-0 shrink-[8] truncate">{t('codeReview.view.by', { author: item.author })}</span>
            </>
          )}
          {badges.length > 0 && (
            <span aria-hidden="true" className="shrink-0">
              ·
            </span>
          )}
          {badges.map(({ key, tone }) => {
            const label = BADGE_LABEL[key]
            return (
              <span
                key={key}
                data-badge={key}
                className={`shrink-0 rounded-control-sm bg-veil-tile px-1.5 font-medium ${TONES[tone]}`}
                {...(label ? { 'aria-label': t(label), role: 'img' } : {})}
              >
                {t(BADGE_TEXT[key])}
              </span>
            )
          })}
        </span>
      </button>
      {/* What a click does, shown on hover or keyboard focus over the time, on the row's own hover
          colour; inset by the 2 px focus ring so the ring stays whole. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0.5 right-0.5 flex rounded-r-tile bg-obsidian-dense opacity-0 transition-opacity duration-150 group-has-[:focus-visible]:opacity-100 group-hover:opacity-100"
      >
        <span className="flex h-full min-w-16 items-center justify-end rounded-r-tile bg-veil pr-3 text-graphite">
          <ExternalLink size={14} strokeWidth={1.8} />
        </span>
      </span>
    </li>
  )
}

function Section({ section, items, onOpen }: { section: ReviewSection; items: readonly ReviewItem[]; onOpen: (id: string) => void }) {
  const t = useT()
  const now = useClock()
  const heading = t(section === 'toReview' ? 'codeReview.view.toReview' : 'codeReview.view.mine')
  const headingId = `reviews-section-${section}`
  return (
    <section data-section={section} aria-labelledby={headingId} className="flex shrink-0 flex-col">
      <h3 id={headingId} className="flex h-7 shrink-0 items-center gap-1.5 px-2.5 text-caps font-medium uppercase text-graphite">
        {heading}
        <span className="tabular">{items.length}</span>
      </h3>
      {items.length === 0 ? (
        <p data-testid="reviews-section-empty" className="flex h-8 items-center px-2.5 text-small text-graphite">
          {t('codeReview.view.sectionEmpty')}
        </p>
      ) : (
        <ul aria-label={heading} className="flex flex-col">
          {items.map((item) => (
            <Row key={item.id} item={item} section={section} now={now} onOpen={() => onOpen(item.id)} />
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * "Por revisar" (review requested from you) and "Míos" (your open PR/MRs), at most 20 each, in one
 * scroll under the fixed header. A click or Enter opens the item in the browser (main checks it).
 */
export function ReviewList({
  list,
  dimmed,
  onOpen,
  ref,
}: {
  list: CodeReviewList
  /** Offline: the last data, faded. */
  dimmed: boolean
  onOpen: (id: string) => void
  ref?: Ref<HTMLDivElement>
}) {
  return (
    <div
      ref={ref}
      data-testid="reviews-list"
      data-dimmed={dimmed || undefined}
      onKeyDown={onListKeyDown}
      className={`-mx-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1 transition-opacity duration-150 ${dimmed ? 'opacity-70' : ''}`}
    >
      <Section section="toReview" items={list.toReview} onOpen={onOpen} />
      <Section section="mine" items={list.mine} onOpen={onOpen} />
    </div>
  )
}
