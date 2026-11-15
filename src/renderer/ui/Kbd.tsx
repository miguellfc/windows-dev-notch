import { formatAccelerator } from '../../shared/settings/accelerator'

/**
 * An Electron accelerator shown as keyboard keys. `glass` is for the translucent capsule, where
 * Grafito would drop under 4.5:1 over a light window behind it.
 */
export function Kbd({
  accelerator,
  size = 'md',
  glass = false,
}: {
  accelerator: string
  size?: 'sm' | 'md'
  glass?: boolean
}) {
  const keys = formatAccelerator(accelerator)
  const chip =
    size === 'sm'
      ? 'h-4.5 min-w-4.5 px-1 text-label rounded-key'
      : 'h-6 min-w-6 px-2 text-label rounded-key'
  return (
    <span className="inline-flex items-center gap-1" aria-label={keys.join(' + ')}>
      {keys.map((key, index) => (
        <kbd
          key={`${key}-${index}`}
          aria-hidden="true"
          className={`inline-flex items-center justify-center border border-line bg-veil font-mono font-medium ${glass ? 'text-graphite-glass' : 'text-graphite'} ${chip}`}
        >
          {key}
        </kbd>
      ))}
    </span>
  )
}
