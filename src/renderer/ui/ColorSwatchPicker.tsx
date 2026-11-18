import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  INTEGRATION_COLOR_HEX,
  integrationColorIds,
  type IntegrationColor,
} from '../../shared/integrations/colors'
import { useT } from '../shared/use-t'
import { radioTabStop } from './roving'
import { nextSwatch } from './swatch-nav'

interface ColorSwatchPickerProps {
  value: IntegrationColor
  onChange: (color: IntegrationColor) => void
  /** Accessible name of the radio group. */
  label: string
  /** The integration's icon, shown left of the button in a 28 px square tinted with the colour. */
  icon?: LucideIcon
}

/**
 * The integration's icon in its colour and a «Cambiar color» button that opens a 3 x 7 grid of the
 * palette below. A radio group: one Tab stop (the current colour), arrows move and select (up/down
 * jump a row), Esc (in the grid or on the button) closes and returns focus to the button; focus
 * leaving the picker closes it too.
 */
export function ColorSwatchPicker({ value, onChange, label, icon: Icon }: ColorSwatchPickerProps) {
  const t = useT()
  const gridId = useId()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const swatches = useRef<(HTMLButtonElement | null)[]>([])
  const checkedIndex = integrationColorIds.indexOf(value)
  const tabStop = radioTabStop(checkedIndex)

  // Entering the grid puts focus on the current colour (only on open: moving the selection must not steal focus).
  useEffect(() => {
    if (open) swatches.current[tabStop]?.focus()
  }, [open])

  const close = () => {
    setOpen(false)
    trigger.current?.focus()
  }

  // Tabbing or clicking out of the picker closes it, without pulling focus back.
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget
    if (!(next instanceof Node && event.currentTarget.contains(next))) setOpen(false)
  }

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    event.stopPropagation()
    close()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    const focused = swatches.current.findIndex((swatch) => swatch === event.target)
    const to = nextSwatch(focused === -1 ? tabStop : focused, event.key)
    const id = to === null ? undefined : integrationColorIds[to]
    if (to === null || !id) return
    event.preventDefault()
    swatches.current[to]?.focus()
    if (id !== value) onChange(id)
  }

  return (
    <div className="flex flex-col items-start gap-2" onBlur={onBlur}>
      <span className="flex items-center gap-2">
        {Icon && (
          <span
            aria-hidden="true"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-tile"
            style={{
              backgroundColor: `color-mix(in srgb, ${INTEGRATION_COLOR_HEX[value]} 14%, transparent)`,
              color: INTEGRATION_COLOR_HEX[value],
            }}
          >
            <Icon size={16} strokeWidth={1.8} />
          </span>
        )}
        <button
          ref={trigger}
          type="button"
          className="btn"
          aria-expanded={open}
          aria-controls={open ? gridId : undefined}
          onClick={() => (open ? close() : setOpen(true))}
          onKeyDown={onTriggerKeyDown}
        >
          {t('cc.integrations.changeColor')}
        </button>
      </span>
      {open && (
        <div
          id={gridId}
          role="radiogroup"
          aria-label={label}
          onKeyDown={onKeyDown}
          className="grid gap-[6px]"
          style={{ gridTemplateColumns: 'repeat(7, 28px)' }}
        >
          {integrationColorIds.map((id, index) => (
            <button
              key={id}
              ref={(element) => {
                swatches.current[index] = element
              }}
              type="button"
              role="radio"
              aria-checked={id === value}
              aria-label={t(`color.${id}`)}
              tabIndex={index === tabStop ? 0 : -1}
              onClick={() => onChange(id)}
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-tile border border-transparent"
              style={{
                backgroundColor: `color-mix(in srgb, ${INTEGRATION_COLOR_HEX[id]} 13%, transparent)`,
                borderColor: id === value ? INTEGRATION_COLOR_HEX[id] : undefined,
              }}
            >
              <span
                aria-hidden="true"
                className="h-[10px] w-[10px] rounded-full"
                style={{ backgroundColor: INTEGRATION_COLOR_HEX[id] }}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
