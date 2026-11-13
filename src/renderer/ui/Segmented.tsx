import { useRef, type KeyboardEvent } from 'react'
import { radioKeyTarget, radioTabStop } from './roving'

interface SegmentedProps<T extends string> {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  /**
   * Shown as tabs (WAI-ARIA tablist): `tab` roles with aria-selected, each controlling `panelId`
   * (labelled back by `tabId(value)`). Keys and look stay the same as the radio group.
   */
  tabs?: { panelId: string; tabId: (value: T) => string }
}

/**
 * A small radio group shown as joined buttons. One Tab stop (the checked option); the arrow
 * keys move and select, wrapping at the ends, as in the APG radio group pattern.
 */
export function Segmented<T extends string>({ label, value, options, onChange, tabs }: SegmentedProps<T>) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const checkedIndex = options.findIndex((option) => option.value === value)
  // With nothing checked the first option takes the Tab stop, so the group is always reachable.
  const tabStop = radioTabStop(checkedIndex)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Move from the option that has focus (not the checked value), as the APG pattern does.
    const focused = buttons.current.findIndex((button) => button === event.target)
    const to = radioKeyTarget(event.key, focused === -1 ? tabStop : focused, options.length)
    const option = to === null ? undefined : options[to]
    if (to === null || !option) return
    event.preventDefault()
    buttons.current[to]?.focus()
    if (option.value !== value) onChange(option.value)
  }

  return (
    <div
      role={tabs ? 'tablist' : 'radiogroup'}
      aria-label={label}
      onKeyDown={onKeyDown}
      className="inline-flex rounded-control border border-line bg-veil p-0.5"
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(element) => {
            buttons.current[index] = element
          }}
          type="button"
          {...(tabs
            ? { role: 'tab', id: tabs.tabId(option.value), 'aria-selected': option.value === value, 'aria-controls': tabs.panelId }
            : { role: 'radio', 'aria-checked': option.value === value })}
          tabIndex={index === tabStop ? 0 : -1}
          onClick={() => onChange(option.value)}
          className="h-7 cursor-pointer rounded-control-sm px-3 text-small text-graphite transition-colors duration-150 hover:text-chalk aria-checked:bg-veil-tile aria-checked:text-chalk aria-selected:bg-veil-tile aria-selected:text-chalk"
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
