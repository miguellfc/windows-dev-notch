const MIN_POINTS = 8

/**
 * The last minute of a 0–100 percentage as a thin line, newest at the right edge (a buffer still filling is stretched across the width). The scale is
 * fixed (0–100), so a quiet minute reads flat instead of being stretched into noise. Static: no
 * animation, no grid; decorative (the card states the value in text).
 */
export function Sparkline({ values, className }: { values: readonly number[]; className?: string }) {
  // Few samples drawn at the full 60 s scale made a sub-pixel stroke at the right edge (a stray comma or dot):
  // nothing until there are MIN_POINTS, then the line spans the card and the older samples fill it in.
  if (values.length < MIN_POINTS) return <div aria-hidden="true" className={className} />
  const points = values.map((value, index) => `${index},${100 - value}`).join(' ')
  return (
    <svg
      aria-hidden="true"
      className={className}
      // A little headroom above 100 % and below 0 % so the stroke is never clipped at the edges.
      viewBox={`0 -4 ${values.length - 1} 108`}
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
