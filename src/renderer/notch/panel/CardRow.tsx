import { Activity, AlarmClock, StickyNote, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type RefObject } from 'react'
import type { MessageKey } from '../../../shared/i18n/messages'
import type { IntegrationKey } from '../../../shared/integrations/colors'
import { ClaudeMark, GithubMark, GitlabMark, GmailMark, RedmineMark } from '../../shared/brand-icons'
import { setReviewsTarget } from '../../shared/code-review-store'
import { useAttentionCount } from '../../shared/reminders-store'
import { remindersBadgeLabel } from '../../shared/reminders/format'
import { useSettings } from '../../shared/settings-store'
import { useLanguage, useT } from '../../shared/use-t'
import { visibleCards } from '../integration-visibility'
import { activePage, cardPages, nextCardIndex, scrollForCard, snapLeft, wheelScroll } from './card-row'
import { CardTabStop, PanelCard } from './PanelCard'

const ICONS: Readonly<Record<IntegrationKey, LucideIcon>> = {
  claude: ClaudeMark,
  github: GithubMark,
  gitlab: GitlabMark,
  gmail: GmailMark,
  redmine: RedmineMark,
  reminders: AlarmClock,
  notes: StickyNote,
  system: Activity,
}

const TITLES: Readonly<Record<IntegrationKey, MessageKey>> = {
  claude: 'claude.section.title',
  github: 'integration.github',
  gitlab: 'integration.gitlab',
  gmail: 'integration.gmail',
  redmine: 'integration.redmine',
  reminders: 'integration.reminders',
  notes: 'integration.notes',
  system: 'integration.system',
}

/** The right edge fades out while more cards are scrolled away. */
const EDGE_MASK: CSSProperties = { maskImage: 'linear-gradient(to right, #000 calc(100% - 48px), transparent)' }

/** How long after the last wheel event the row forgets the distance it was adding up. */
const WHEEL_IDLE_MS = 200

/** Opens what a card stands for: its view, the reviews on its platform, or Claude itself. */
export function openCard(key: IntegrationKey): void {
  if (key === 'claude') {
    void window.notch.claude.focusApp()
  } else if (key === 'github' || key === 'gitlab') {
    setReviewsTarget({ platform: key })
    void window.notch.notch.openIntegration({ id: 'reviews' })
  } else {
    void window.notch.notch.openIntegration({ id: key })
  }
}

function scrollBehavior(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}

/**
 * The wheel scrolls the row sideways, one card at a time. Mandatory snapping would pull a small delta
 * straight back (a touchpad would never move), so the deltas add up and the row only moves once they
 * reach the next card. React's `onWheel` is passive, so the listener is attached by hand.
 */
function useWheelScroll(scroller: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = scroller.current
    if (!element) return
    let target: number | null = null
    let idle: ReturnType<typeof setTimeout> | undefined
    const onWheel = (event: WheelEvent) => {
      const maxScroll = element.scrollWidth - element.clientWidth
      const from = target ?? element.scrollLeft
      const { left, consumed } = wheelScroll(event.deltaX, event.deltaY, from, maxScroll)
      if (!consumed) return
      event.preventDefault()
      const snapped = snapLeft(left, maxScroll)
      if (snapped === snapLeft(from, maxScroll)) {
        target = left
      } else {
        target = snapped
        element.scrollTo({ left: snapped, behavior: scrollBehavior() })
      }
      clearTimeout(idle)
      idle = setTimeout(() => {
        target = null
      }, WHEEL_IDLE_MS)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      element.removeEventListener('wheel', onWheel)
      clearTimeout(idle)
    }
  }, [scroller])
}

/** Where the row stands: the active page is a 16×4 bar and the others 4 px dots. */
function PageIndicator({ page, pages }: { page: number; pages: number }) {
  return (
    <div aria-hidden="true" data-testid="card-row-pages" className="mt-2 flex h-1 items-center justify-center gap-1">
      {Array.from({ length: pages }, (_, index) => (
        <span key={index} className={index === page ? 'h-1 w-4 rounded-full bg-chalk' : 'size-1 rounded-full bg-graphite'} />
      ))}
    </div>
  )
}

/**
 * The integrations' cards, 3.5 in view. The row is one Tab stop: the arrow keys move the focus along
 * it and Enter opens the card. With more than three cards a tail of half a card closes the row
 * (86 px, plus the 10 px gap), so the last three can snap to its start: every page is reachable.
 */
export function CardRow() {
  const t = useT()
  const language = useLanguage()
  const integrations = useSettings((state) => state.settings?.integrations ?? null)
  const remindersDue = useAttentionCount()
  const scroller = useRef<HTMLUListElement>(null)
  const [scrolledPage, setScrolledPage] = useState(0)
  const [focused, setFocused] = useState(0)
  useWheelScroll(scroller)

  const keys = integrations ? visibleCards(integrations) : []
  const count = keys.length
  const pages = cardPages(count)
  const overflows = count > 3
  // Turning an integration off can leave either of them past the end.
  const page = Math.min(scrolledPage, pages - 1)
  const tabStop = Math.min(focused, Math.max(count - 1, 0))

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const next = nextCardIndex(tabStop, event.key, count)
    if (next === tabStop) return
    const element = event.currentTarget
    setFocused(next)
    element.querySelector<HTMLElement>(`[data-card-index="${next}"] [data-card-main]`)?.focus({ preventScroll: true })
    element.scrollTo({ left: scrollForCard(next, element.scrollLeft), behavior: scrollBehavior() })
  }

  // A click or a Tab lands on a card too: the arrow keys carry on from there.
  const onFocus = (event: FocusEvent<HTMLUListElement>) => {
    const item = event.target.closest<HTMLElement>('[data-card-index]')
    if (item) setFocused(Number(item.dataset.cardIndex))
  }

  return (
    <div className="flex w-[632px] shrink-0 flex-col">
      <ul
        ref={scroller}
        aria-label={t('panel.cards')}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onScroll={(event) => setScrolledPage(activePage(event.currentTarget.scrollLeft, pages))}
        style={overflows ? EDGE_MASK : undefined}
        className={`flex h-[196px] snap-x snap-mandatory gap-2.5 overflow-x-auto overflow-y-hidden [scrollbar-width:none] ${
          overflows ? "after:w-[86px] after:shrink-0 after:content-['']" : ''
        }`}
      >
        {keys.map((key, index) => (
          <li key={key} data-card-index={index} className="shrink-0 snap-start">
            <CardTabStop.Provider value={index === tabStop}>
              <PanelCard
                cardKey={key}
                title={t(TITLES[key])}
                icon={ICONS[key]}
                testId={key === 'claude' ? 'claude-sessions' : `integration-${key}`}
                labelTestId={`integration-${key}-label`}
                onOpen={() => openCard(key)}
                badge={key === 'reminders' && remindersDue > 0 ? { count: remindersDue, label: remindersBadgeLabel(remindersDue, language) } : undefined}
              />
            </CardTabStop.Provider>
          </li>
        ))}
      </ul>
      {overflows && <PageIndicator page={page} pages={pages} />}
    </div>
  )
}
