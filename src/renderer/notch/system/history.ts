/** Samples a sparkline keeps: 60 s at the System view's 1 s rhythm. */
export const HISTORY_LENGTH = 60

/**
 * A new buffer with `value` (a percentage, clamped to 0–100) appended, holding at most the last
 * `max` values. A missing or non-finite value leaves the history as it was. Never mutates `buffer`.
 */
export function pushHistory(buffer: readonly number[], value: number | null, max = HISTORY_LENGTH): number[] {
  const next = value === null || !Number.isFinite(value) ? [...buffer] : [...buffer, Math.min(100, Math.max(0, value))]
  return next.length > max ? next.slice(next.length - max) : next
}
