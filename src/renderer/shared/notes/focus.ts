/** The row action that held focus before it was dropped: which note, which control, and where the row was. */
export interface FocusMemo {
  id: string
  /** `data-testid` of the focused control, if any. */
  control: string | null
  index: number
}

/**
 * Where focus goes after the list re-rendered and dropped it. The same note and control when the
 * note is still listed (Pin reorders rows); otherwise the row now at the same position (else the
 * last), on its first action (`control` null). Null when no row is left.
 */
export function focusTarget(ids: readonly string[], memo: FocusMemo): { index: number; control: string | null } | null {
  const same = ids.indexOf(memo.id)
  if (same !== -1) return { index: same, control: memo.control }
  if (ids.length === 0) return null
  return { index: Math.min(memo.index, ids.length - 1), control: null }
}
