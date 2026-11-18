import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
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
}

/**
 * «Cambiar color» button that opens a 3 x 7 grid of the palette. A radio group: one Tab stop
 * (the current colour), arrows move and select (up/down jump a row), Esc closes and returns
 * focus to the button.
 */
export function ColorSwatchPicker({ value, onChange, label }: ColorSwatchPickerProps) {
  const t = useT()
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
    <div className="flex flex-col items-start gap-2">
      <button
        ref={trigger}
        type="button"
        className="btn"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {t('cc.integrations.changeColor')}
      </button>
      {open && (
        <div
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
