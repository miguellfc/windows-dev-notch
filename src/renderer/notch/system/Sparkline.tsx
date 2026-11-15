import { HISTORY_LENGTH } from './history'

/**
 * The last minute of a 0–100 percentage as a thin line, newest at the right edge. The scale is
 * fixed (0–100), so a quiet minute reads flat instead of being stretched into noise. Static: no
 * animation, no grid; decorative (the card states the value in text).
 */
export function Sparkline({ values, className }: { values: readonly number[]; className?: string }) {
  if (values.length < 2) return <div aria-hidden="true" className={className} />
  const offset = HISTORY_LENGTH - values.length
  const points = values.map((value, index) => `${offset + index},${100 - value}`).join(' ')
  return (
    <svg
      aria-hidden="true"
      className={className}
      // A little headroom above 100 % and below 0 % so the stroke is never clipped at the edges.
      viewBox={`0 -4 ${HISTORY_LENGTH - 1} 108`}
      preserveAspectRatio="none"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
