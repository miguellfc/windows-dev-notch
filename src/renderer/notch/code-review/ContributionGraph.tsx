import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { ContributionDay } from '../../../shared/code-review/schema'
import { dayCellLabel, gridKeyTarget, monthName, shortDate, weekdayNames } from '../../shared/code-review/contributions-format'
import { useLanguage, useT } from '../../shared/use-t'

/** Level 0 is Grafito at 14 %, 1-4 step up the Azul Hielo (tokens in global.css). */
const LEVEL_FILL = ['bg-contrib-0', 'bg-contrib-1', 'bg-contrib-2', 'bg-contrib-3', 'bg-contrib-4'] as const

/** 14 px squares, 3 px apart (the gap holds the focus ring and today's mark). */
const CELL = 'block size-[14px] shrink-0 rounded-[3px]'

const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])

const ROWS = [0, 1, 2, 3, 4, 5, 6] as const

/**
 * The month chart: 7 rows (Monday → Sunday) × one column per week (4-6), days outside the month
 * left blank (the slot stays), future days outlined, today ringed. A `role="grid"` with one Tab
 * stop (today): ↑/↓ move a day, ←/→ a week, Home/End along the weekday row; hovering or focusing
 * a square reports "12 nov · 7 contribuciones" through `onShowDay` (the summary writes it).
 *
 * Without data (`interactive` false: loading or failed) it is the same grid, all grey, hidden from
 * screen readers and out of the Tab order; `pulse` animates it while loading (never with reduced motion).
 */
export function ContributionGraph({
  weeks,
  month,
  today,
  interactive,
  pulse = false,
  description,
  onShowDay,
}: {
  weeks: readonly (readonly ContributionDay[])[]
  /** `YYYY-MM`. */
  month: string
  /** Today's `YYYY-MM-DD` (local). */
  today: string
  interactive: boolean
  pulse?: boolean
  /** Screen-reader summary: "Noviembre: 84 contribuciones en 15 días activos". */
  description?: string
  /** The hovered or focused square's text, or null when none is. */
  onShowDay?: (text: string | null) => void
}) {
  const t = useT()
  const language = useLanguage()
  const id = useId()
  const grid = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const [active, setActive] = useState<string | null>(null)

  const days = weeks.flat().filter((d) => d.inMonth)
  // The Tab stop: the last day moved to, else today, else the 1st.
  const stop = (active !== null && days.some((d) => d.date === active) ? active : null) ?? days.find((d) => d.date === today)?.date ?? days[0]?.date ?? null
  const shown = hovered ?? focused
  const shownDay = shown === null ? undefined : days.find((d) => d.date === shown)
  const shownText = shownDay ? dayCellLabel(shownDay, language) : null
  useEffect(() => onShowDay?.(shownText), [onShowDay, shownText])
  const narrow = weekdayNames(language, 'narrow')
  const long = weekdayNames(language, 'long')
  const title = monthName(month, language, true)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive || !NAV_KEYS.has(event.key) || stop === null) return
    // Handled here even at the month's edge: the view's arrows (tabs, list) must not fire from the chart.
    event.preventDefault()
    const target = gridKeyTarget(weeks, focused ?? stop, event.key)
    if (target === null) return
    setActive(target)
    grid.current?.querySelector<HTMLElement>(`[data-date="${target}"]`)?.focus()
  }

  return (
    // Fixed at the width of 6 columns (12 px labels + 3 px + 6 × 14 px + 5 × 3 px): the summary
    // beside it never moves with the month's columns.
    <div data-testid="contribution-graph" className="flex w-[114px] shrink-0 flex-col gap-1">
      <p id={`${id}-month`} className="h-4 pl-[15px] text-label font-medium leading-4 text-graphite">
        {title}
      </p>
      <div
        ref={grid}
        {...(interactive
          ? {
              role: 'grid',
              'aria-label': t('codeReview.contrib.graph', { month: monthName(month, language) }),
              'aria-readonly': true,
              ...(description ? { 'aria-describedby': `${id}-summary` } : {}),
            }
          : { 'aria-hidden': true })}
        data-loading={pulse || undefined}
        onKeyDown={onKeyDown}
        className={`relative flex flex-col gap-[3px] ${pulse ? 'animate-pulse motion-reduce:animate-none' : ''}`}
      >
        {interactive && (
          <div role="row" className="sr-only">
            <span role="columnheader">{t('codeReview.contrib.weekday')}</span>
            {weeks.map((week) => (
              <span key={week[0]?.date} role="columnheader">
                {t('codeReview.contrib.weekOf', { date: shortDate(week[0]?.date ?? '', language) })}
              </span>
            ))}
          </div>
        )}
        {ROWS.map((row) => (
          <div key={row} role={interactive ? 'row' : undefined} className="flex gap-[3px]">
            <span role={interactive ? 'rowheader' : undefined} className="w-3 shrink-0 text-label leading-[14px] text-graphite">
              {/* Every weekday is labelled (L M X J V S D / M T W T F S S). */}
              <span aria-hidden="true">{narrow[row]}</span>
              {interactive && <span className="sr-only">{long[row]}</span>}
            </span>
            {weeks.map((week) => {
              const day = week[row]
              if (!day) return null
              if (!day.inMonth) return <span key={day.date} role={interactive ? 'gridcell' : undefined} className={CELL} />
              const isToday = day.date === today
              return (
                <span
                  key={day.date}
                  data-date={day.date}
                  data-level={day.level}
                  data-future={day.future || undefined}
                  data-today={isToday || undefined}
                  {...(interactive
                    ? {
                        role: 'gridcell',
                        tabIndex: day.date === stop ? 0 : -1,
                        'aria-label': dayCellLabel(day, language),
                        ...(isToday ? { 'aria-current': 'date' as const } : {}),
                        onFocus: () => {
                          setFocused(day.date)
                          setActive(day.date)
                        },
                        onBlur: () => setFocused(null),
                      }
                    : {})}
                  onMouseEnter={interactive ? () => setHovered(day.date) : undefined}
                  onMouseLeave={interactive ? () => setHovered(null) : undefined}
                  className={`contrib-cell ${CELL} ${day.future ? 'border border-line' : LEVEL_FILL[interactive ? day.level : 0]} ${isToday && interactive ? 'contrib-today' : ''}`}
                />
              )
            })}
          </div>
        ))}
      </div>
      {interactive && description && (
        <p id={`${id}-summary`} className="sr-only">
          {description}
        </p>
      )}
    </div>
  )
}
