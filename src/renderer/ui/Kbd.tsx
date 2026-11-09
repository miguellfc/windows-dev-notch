import { formatAccelerator } from '../../shared/settings/accelerator'

/** An Electron accelerator shown as keyboard keys. */
export function Kbd({ accelerator, size = 'md' }: { accelerator: string; size?: 'sm' | 'md' }) {
  const keys = formatAccelerator(accelerator)
  const chip =
    size === 'sm'
      ? 'h-5 min-w-5 px-1.5 text-label rounded-[6px]'
      : 'h-6 min-w-6 px-2 text-label rounded-[7px]'
  return (
    <span className="inline-flex items-center gap-1" aria-label={keys.join(' + ')}>
      {keys.map((key, index) => (
        <kbd
          key={`${key}-${index}`}
          aria-hidden="true"
          className={`inline-flex items-center justify-center border border-line bg-veil font-mono font-medium text-graphite ${chip}`}
        >
          {key}
        </kbd>
      ))}
    </span>
  )
}
