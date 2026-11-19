import type { RedmineIssue } from '../../../shared/redmine/schema'
import { matchesIssue } from './format'

/** The rows the search shows at most; the rest are counted. */
const MAX_ROWS = 5

/** What a query leads to in the Redmine view. */
export type SearchResult =
  | { readonly kind: 'idle' }
  | { readonly kind: 'one'; readonly id: number }
  | { readonly kind: 'many'; readonly issues: readonly RedmineIssue[]; readonly more: number }
  | { readonly kind: 'lookup'; readonly id: number }
  | { readonly kind: 'none' }

/**
 * Reads the search box over the loaded issues. An exact id in the list wins over the issues that
 * carry the number in their text; a number nothing matches is asked of Redmine (`lookup`), unless no
 * issue could have it.
 */
export function redmineSearch(query: string, issues: readonly RedmineIssue[]): SearchResult {
  const text = query.trim()
  if (text === '') return { kind: 'idle' }
  const digits = /^#?(\d+)$/.exec(text)?.[1]
  const id = digits === undefined ? null : Number(digits)
  if (id !== null && issues.some((issue) => issue.id === id)) return { kind: 'one', id }
  const matches = issues.filter((issue) => matchesIssue(issue, text))
  const [first] = matches
  if (first && matches.length === 1) return { kind: 'one', id: first.id }
  if (matches.length > 1) return { kind: 'many', issues: matches.slice(0, MAX_ROWS), more: Math.max(0, matches.length - MAX_ROWS) }
  return id !== null && id >= 1 && Number.isSafeInteger(id) ? { kind: 'lookup', id } : { kind: 'none' }
}

/** The search for one number outside the list. */
export type LookupState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'searching' | 'found' | 'missing' | 'failed'; readonly id: number }

export type LookupEvent =
  | { readonly type: 'query'; readonly id: number }
  | { readonly type: 'clear' }
  | { readonly type: 'answer'; readonly id: number; readonly found: boolean }
  | { readonly type: 'failed'; readonly id: number }

/** Folds one event of the lookup (pure): only the answer to the number being asked counts. */
export function searchStep(current: LookupState, event: LookupEvent): LookupState {
  if (event.type === 'clear') return { phase: 'idle' }
  if (event.type === 'query') return { phase: 'searching', id: event.id }
  if (current.phase !== 'searching' || current.id !== event.id) return current
  if (event.type === 'failed') return { phase: 'failed', id: event.id }
  return { phase: event.found ? 'found' : 'missing', id: event.id }
}
