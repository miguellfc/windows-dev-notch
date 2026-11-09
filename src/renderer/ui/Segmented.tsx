interface SegmentedProps<T extends string> {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
}

/** A small radio group shown as joined buttons. */
export function Segmented<T extends string>({ label, value, options, onChange }: SegmentedProps<T>) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-control border border-line bg-veil p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className="h-7 cursor-pointer rounded-[8px] px-3 text-small text-graphite transition-colors duration-150 hover:text-chalk aria-checked:bg-veil-tile aria-checked:text-chalk"
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
