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
 * carry the number in their text. An explicit `#number` outside the list is always asked of Redmine
 * (`lookup`), whatever the texts say; bare digits are read as text first and asked only when nothing
 * matches. A number no issue could have is never asked.
 */
export function redmineSearch(query: string, issues: readonly RedmineIssue[]): SearchResult {
  const text = query.trim()
  if (text === '') return { kind: 'idle' }
  const digits = /^#?(\d+)$/.exec(text)?.[1]
  const id = digits === undefined ? null : Number(digits)
  if (id !== null && issues.some((issue) => issue.id === id)) return { kind: 'one', id }
  const askable = id !== null && id >= 1 && Number.isSafeInteger(id)
  if (id !== null && text.startsWith('#')) return askable ? { kind: 'lookup', id } : { kind: 'none' }
  const matches = issues.filter((issue) => matchesIssue(issue, text))
  const [first] = matches
  if (first && matches.length === 1) return { kind: 'one', id: first.id }
  if (matches.length > 1) return { kind: 'many', issues: matches.slice(0, MAX_ROWS), more: Math.max(0, matches.length - MAX_ROWS) }
  return askable ? { kind: 'lookup', id } : { kind: 'none' }
}

/**
 * Whether the empty result of a text search should say the list was cut: main reads at most the 300
 * most recently updated assigned issues, so an older one may exist. A `#number` is always asked of
 * Redmine, so it never needs the hint.
 */
export function truncatedSearchHint(query: string, result: SearchResult, truncated: boolean): boolean {
  return truncated && result.kind === 'none' && !query.trim().startsWith('#')
}

/** A query with what it resolved to. */
export interface SettledSearch {
  readonly query: string
  readonly result: SearchResult
}

/**
 * What the view shows for `query` (pure; null until the list first loads). The list is read again
 * after every write and poll, and an issue closed or reassigned leaves it, so a query resolves once
 * and stays resolved until its text changes: an open detail never gives way under the user. Rows
 * already shown stay, with their latest data. Returns `previous` itself when nothing changed.
 */
export function settleSearch(previous: SettledSearch | null, query: string, issues: readonly RedmineIssue[] | null): SettledSearch | null {
  if (previous === null || previous.query.trim() !== query.trim()) {
    return issues === null ? null : { query, result: redmineSearch(query, issues) }
  }
  const kept = previous.result
  if (kept.kind !== 'many' || issues === null) return previous
  const rows = kept.issues.map((row) => issues.find((issue) => issue.id === row.id) ?? row)
  return rows.every((row, index) => row === kept.issues[index]) ? previous : { query: previous.query, result: { ...kept, issues: rows } }
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
