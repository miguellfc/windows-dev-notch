import type { ProcessOrder, ProcessRow } from '../../../shared/system/schema'

/** Identifies a row across PID reuse. */
export const rowId = (row: ProcessRow): string => `${row.pid}:${row.startTime}`

/** Highest first; a value not read yet sorts last. */
export const sortRows = (rows: readonly ProcessRow[], order: ProcessOrder): ProcessRow[] => {
  const key = (row: ProcessRow) => (order === 'cpu' ? row.cpuPercent : row.privateBytes) ?? -1
  return [...rows].sort((a, b) => key(b) - key(a))
}

/**
 * The rows in a frozen order (the ids as shown when a close question opened), so CPU re-ranks
 * cannot move the question or the row under the pointer. Rows that left are dropped; rows that
 * arrived since go after the frozen ones, in their current order.
 */
export const freezeOrder = (rows: readonly ProcessRow[], frozen: readonly string[]): ProcessRow[] => {
  const position = new Map(frozen.map((id, index) => [id, index]))
  const kept = rows.filter((row) => position.has(rowId(row)))
  kept.sort((a, b) => (position.get(rowId(a)) ?? 0) - (position.get(rowId(b)) ?? 0))
  return [...kept, ...rows.filter((row) => !position.has(rowId(row)))]
}
