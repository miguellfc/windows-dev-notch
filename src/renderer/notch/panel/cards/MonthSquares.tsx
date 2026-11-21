import type { ContributionDay } from '../../../../shared/code-review/schema'
import { LEVEL_FILL } from '../../code-review/ContributionGraph'

function dayFill(day: ContributionDay): string {
  if (!day.inMonth) return ''
  return day.future ? 'border border-line' : LEVEL_FILL[day.level]
}

/**
 * A card's month chart in 9 px squares, 2 px apart: one column per week, Monday on top, the days
 * outside the month left blank and future days outlined. With `today` its square is ringed, as in
 * the views. Decorative: the card's figures say what it shows.
 */
export function MonthSquares({ weeks, today }: { weeks: readonly (readonly ContributionDay[])[]; today?: string }) {
  return (
    <div aria-hidden="true" className="flex gap-0.5">
      {weeks.map((week) => (
        <div key={week[0]?.date} className="flex flex-col gap-0.5">
          {week.map((day) => (
            <span
              key={day.date}
              data-level={day.inMonth && !day.future ? day.level : undefined}
              data-today={(day.inMonth && day.date === today) || undefined}
              className={`block size-[9px] rounded-[2px] ${dayFill(day)} ${day.inMonth && day.date === today ? 'contrib-today' : ''}`}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
