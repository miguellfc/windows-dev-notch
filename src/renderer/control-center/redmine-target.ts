/** Plain digits with at most one decimal after a comma or a dot (never `0x10`, `1e1`, `+8`). */
const TARGET_TEXT = /^\d+([.,]\d)?$/

/** A target of 1-24 h in steps of 0.5, typed with a comma or a dot; null when it is anything else. */
export function parseTarget(raw: string): number | null {
  const text = raw.trim()
  if (!TARGET_TEXT.test(text)) return null
  const value = Number(text.replace(',', '.'))
  if (value < 1 || value > 24 || !Number.isInteger(value * 2)) return null
  return value
}
