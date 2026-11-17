const SIZE = 40
const STROKE = 4
const RADIUS = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * A 40 px progress ring (the card's figure says the value in text; this is decorative). Track in
 * #222226, arc in the integration colour, red past the alert threshold. 52 px does not fit the
 * 64 px metric card of the 520x280 System view, so it is the brief's 40 px fallback.
 */
export function Ring({ percent, alert = false }: { percent: number | null; alert?: boolean }) {
  const clamped = Math.min(100, Math.max(0, percent ?? 0))
  return (
    <svg aria-hidden="true" width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="shrink-0 -rotate-90">
      <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke="#222226" strokeWidth={STROKE} />
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        stroke={alert ? 'var(--color-fail)' : 'var(--int, var(--color-int-default))'}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE * (1 - clamped / 100)}
      />
    </svg>
  )
}
