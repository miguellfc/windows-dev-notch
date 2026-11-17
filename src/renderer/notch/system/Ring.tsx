const STROKE = 4

/**
 * A progress ring (the card's figure says the value in text; this is decorative). Track in
 * #222226, arc in the integration colour, red past the alert threshold. 52 px does not fit the
 * 64 px metric card of the 520x280 System view: 40 px alone, 32 px when a battery card narrows
 * the grid.
 */
export function Ring({ percent, alert = false, size = 40 }: { percent: number | null; alert?: boolean; size?: number }) {
  const radius = (size - STROKE) / 2
  const circumference = 2 * Math.PI * radius
  const clamped = Math.min(100, Math.max(0, percent ?? 0))
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#222226" strokeWidth={STROKE} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={alert ? 'var(--color-fail)' : 'var(--int, var(--color-int-default))'}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - clamped / 100)}
      />
    </svg>
  )
}
