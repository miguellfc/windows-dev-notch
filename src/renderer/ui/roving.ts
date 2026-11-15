/**
 * Arrow-key navigation of a radio group (WAI-ARIA APG): Right/Down go to the next option,
 * Left/Up to the previous one, both wrapping; Home and End jump to the ends. Returns the index
 * to move to from `from`, or null when the key does not navigate (or there are no options).
 */
export function radioKeyTarget(key: string, from: number, count: number): number | null {
  if (count <= 0) return null
  const last = count - 1
  const current = Math.min(Math.max(from, 0), last)
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return current === last ? 0 : current + 1
    case 'ArrowLeft':
    case 'ArrowUp':
      return current === 0 ? last : current - 1
    case 'Home':
      return 0
    case 'End':
      return last
    default:
      return null
  }
}

/** The single Tab stop of the group: the checked option, else the first one. */
export function radioTabStop(checkedIndex: number): number {
  return checkedIndex < 0 ? 0 : checkedIndex
}
