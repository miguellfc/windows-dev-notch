const MS_PER_MINUTE = 60_000

/** Formats a duration in milliseconds as `Xh Ym`, `Xh` or `Ym` (minutes truncated; negatives read as 0). */
export function durationText(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / MS_PER_MINUTE))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes}m`
  if (minutes === 0) return `${hours}h`
  return `${hours}h ${minutes}m`
}
