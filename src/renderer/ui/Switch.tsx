interface SwitchProps {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: (checked: boolean) => void
}

export function Switch({ checked, disabled = false, label, onChange }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border border-line bg-veil-tile transition-colors duration-200 aria-checked:border-ice/40 aria-checked:bg-ice/25 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span
        aria-hidden="true"
        className={`ml-[3px] h-4 w-4 rounded-full transition-transform duration-200 ease-out ${
          checked ? 'translate-x-4 bg-ice' : 'translate-x-0 bg-graphite'
        }`}
      />
    </button>
  )
}
