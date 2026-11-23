const MS_PER_MINUTE = 60_000

/**
 * Rounds each of `values` (ms) to whole minutes by largest remainder, so they add up to the whole
 * minutes of `targetMs` (what `durationText` shows for it): each value is cut to its minute, then
 * the minutes still missing go one each to the largest remainders (the first on a tie). Values above
 * the target lose minutes from the smallest remainders (the last on a tie). Negative values read as
 * 0. Results in ms. Same algorithm as `src-tauri/src/work_log/rounding.rs`, checked by the shared
 * cases in `tests/parity/work-log-rounding.json`.
 */
export function roundToMinutes(values: readonly number[], targetMs: number): number[] {
  const clean = values.map((value) => Math.max(0, value))
  const minutes = clean.map((value) => Math.floor(value / MS_PER_MINUTE))
  const remainder = (i: number) => (clean[i] ?? 0) % MS_PER_MINUTE
  const target = Math.max(0, Math.floor(targetMs / MS_PER_MINUTE))
  const missing = target - minutes.reduce((sum, value) => sum + value, 0)
  const order = clean.map((_, i) => i)
  if (missing > 0) {
    // Largest remainder first, the first on a tie (the sort is stable).
    order.sort((a, b) => remainder(b) - remainder(a))
    for (const i of order.slice(0, missing)) minutes[i] = (minutes[i] ?? 0) + 1
  } else if (missing < 0) {
    // Smallest remainder first, the last on a tie.
    order.reverse()
    order.sort((a, b) => remainder(a) - remainder(b))
    let extra = -missing
    for (const i of order) {
      if (extra === 0) break
      if ((minutes[i] ?? 0) > 0) {
        minutes[i] = (minutes[i] ?? 0) - 1
        extra -= 1
      }
    }
  }
  return minutes.map((value) => value * MS_PER_MINUTE)
}
