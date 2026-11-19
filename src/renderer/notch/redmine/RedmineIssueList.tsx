import { ChevronRight } from 'lucide-react'
import type { KeyboardEvent, Ref } from 'react'
import type { RedmineIssue } from '../../../shared/redmine/schema'
import { issueHoursText } from '../../shared/redmine/format'
import { useLanguage, useT } from '../../shared/use-t'
import { radioKeyTarget } from '../../ui/roving'

const ROW = '[data-testid="redmine-issue"]'

/** The rows shown, in order. */
export const issueRows = (root: HTMLElement | null): HTMLElement[] => (root ? [...root.querySelectorAll<HTMLElement>(ROW)] : [])

/** The row of one issue, if it is shown. */
export const issueRow = (root: HTMLElement | null, id: number): HTMLElement | null =>
  root?.querySelector<HTMLElement>(`[data-issue-id="${id}"] ${ROW}`) ?? null

/** Up/Down (wrapping), Home and End move between rows; Enter is the row's own click. */
const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'Home' && event.key !== 'End') return
  const rows = issueRows(event.currentTarget)
  const from = rows.indexOf(document.activeElement as HTMLElement)
  if (from === -1) return
  const to = radioKeyTarget(event.key, from, rows.length)
  if (to === null) return
  event.preventDefault()
  const row = rows[to]
  row?.focus()
  row?.scrollIntoView({ block: 'nearest' })
}

function Row({ issue, onOpen }: { issue: RedmineIssue; onOpen: () => void }) {
  const language = useLanguage()
  const hours = issueHoursText(issue, language)
  return (
    <li data-issue-id={issue.id} className="group relative flex shrink-0">
      <button
        type="button"
        data-testid="redmine-issue"
        onClick={onOpen}
        className="focus-inset flex h-[50px] w-full min-w-0 cursor-pointer flex-col justify-center gap-0.5 rounded-tile px-2.5 text-left transition-colors duration-150 group-hover:bg-veil-tile focus-visible:bg-veil-tile"
      >
        {/* Line 1: the number stays whole, the subject takes the room. Subjects, statuses and
            projects are always plain text: React escapes them. */}
        <span className="flex w-full min-w-0 items-baseline gap-1.5 pr-5">
          <span data-testid="redmine-issue-id" className="tabular shrink-0 text-small leading-[18px] text-graphite">
            #{issue.id}
          </span>
          <span data-testid="redmine-issue-subject" className="min-w-0 flex-1 truncate text-body leading-[18px] text-chalk">
            {issue.subject}
          </span>
        </span>
        {/* Line 2: status · hours · project. The project gives way first, the hours are never cut. */}
        <span className="flex h-4 w-full min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap pr-5 text-label leading-4 text-graphite">
          <span data-testid="redmine-issue-status" className="min-w-0 shrink truncate">
            {issue.status.name}
          </span>
          {hours !== null && (
            <>
              <span aria-hidden="true" className="shrink-0">
                ·
              </span>
              <span data-testid="redmine-issue-hours" className="tabular shrink-0">
                {hours}
              </span>
            </>
          )}
          <span aria-hidden="true" className="shrink-0">
            ·
          </span>
          <span data-testid="redmine-issue-project" className="min-w-0 shrink-[8] truncate">
            {issue.project}
          </span>
        </span>
      </button>
      {/* A click opens the detail inside the view: the chevron says so on hover or keyboard focus. */}
      <ChevronRight
        size={14}
        strokeWidth={1.8}
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-graphite opacity-0 transition-opacity duration-150 group-has-[:focus-visible]:opacity-100 group-hover:opacity-100"
      />
    </li>
  )
}

/**
 * The matches of the search (5 rows at most), most recently updated first. A click or Enter opens
 * the issue's detail; "2 más · afina la búsqueda" closes the list when more issues match.
 */
export function RedmineIssueList({
  issues,
  more,
  dimmed,
  onOpen,
  ref,
}: {
  issues: readonly RedmineIssue[]
  /** Matches left out of the rows. */
  more: number
  /** Offline: the last data, faded. */
  dimmed: boolean
  onOpen: (id: number) => void
  ref?: Ref<HTMLDivElement>
}) {
  const t = useT()
  return (
    <div
      ref={ref}
      data-testid="redmine-list"
      data-dimmed={dimmed || undefined}
      onKeyDown={onListKeyDown}
      className={`card flex min-h-0 flex-col overflow-y-auto p-1 transition-opacity duration-150 ${dimmed ? 'opacity-70' : ''}`}
    >
      {issues.length === 0 ? (
        <p data-testid="redmine-no-match" className="flex h-10 shrink-0 items-center px-2.5 text-small text-graphite">
          {t('redmine.view.noMatch')}
        </p>
      ) : (
        <ul aria-label={t('redmine.view.list')} className="flex flex-col">
          {issues.map((issue) => (
            <Row key={issue.id} issue={issue} onOpen={() => onOpen(issue.id)} />
          ))}
        </ul>
      )}
      {more > 0 && (
        <p data-testid="redmine-search-more" className="flex h-8 shrink-0 items-center px-2.5 text-label text-graphite">
          {t('redmine.search.more', { count: more })}
        </p>
      )}
    </div>
  )
}
