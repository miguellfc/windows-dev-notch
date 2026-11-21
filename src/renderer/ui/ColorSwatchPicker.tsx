import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { X, type LucideIcon } from 'lucide-react'
import {
  INTEGRATION_COLOR_HEX,
  colorHex,
  integrationColorIds,
  paletteIdFor,
  type IntegrationColor,
} from '../../shared/integrations/colors'
import { LEVEL_FILL } from '../notch/code-review/ContributionGraph'
import { useLanguage, useT } from '../shared/use-t'
import { checkColor, colorToStore, formatRatio, hexToHsl, hslToHex, normalizeHex, type Hsl } from './color-picker-math'
import { radioKeyTarget, radioTabStop } from './roving'

interface ColorSwatchPickerProps {
  value: IntegrationColor
  onChange: (color: IntegrationColor) => void
  /** The integration's name, for the popup's title («Color de GitHub»). */
  name: string
  /** The integration's icon, shown left of the button in a 28 px square tinted with the colour. */
  icon?: LucideIcon
}

/**
 * The integration's icon in its colour and a «Cambiar color» button (with a dot of the current
 * colour) that opens the colour popup. Only Save changes the setting.
 */
export function ColorSwatchPicker({ value, onChange, name, icon: Icon }: ColorSwatchPickerProps) {
  const t = useT()
  const dialogId = useId()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const hex = colorHex(value)

  const close = () => {
    setOpen(false)
    trigger.current?.focus()
  }

  return (
    <span className="flex items-center gap-2">
      {Icon && (
        <span
          aria-hidden="true"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-tile"
          style={{ backgroundColor: `color-mix(in srgb, ${hex} 14%, transparent)`, color: hex }}
        >
          <Icon size={16} strokeWidth={1.8} />
        </span>
      )}
      <button
        ref={trigger}
        type="button"
        className="btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span aria-hidden="true" className="h-[10px] w-[10px] shrink-0 rounded-full" style={{ backgroundColor: hex }} />
        {t('cc.integrations.changeColor')}
      </button>
      {open &&
        createPortal(
          <ColorPopup
            id={dialogId}
            anchor={trigger}
            value={value}
            name={name}
            icon={Icon}
            onSave={(color) => {
              if (color !== value) onChange(color)
              close()
            }}
            onClose={close}
          />,
          document.body,
        )}
    </span>
  )
}

const POPUP_WIDTH = 340
/** Distance from the window edges and from the trigger. */
const MARGIN = 8
const GAP = 6

/** The preview's 9 x 3 contribution levels (a fixed, plausible-looking week pattern). */
const PREVIEW_LEVELS = [0, 1, 2, 0, 3, 4, 2, 1, 0, 1, 3, 4, 2, 0, 1, 2, 4, 3, 2, 0, 1, 4, 3, 2, 0, 1, 2] as const

interface Draft {
  hex: string
  hsl: Hsl
}

const draftFromHex = (hex: string): Draft => ({ hex, hsl: hexToHsl(hex) })

interface ColorPopupProps {
  id: string
  anchor: RefObject<HTMLButtonElement | null>
  value: IntegrationColor
  name: string
  icon?: LucideIcon | undefined
  onSave: (color: IntegrationColor) => void
  onClose: () => void
}

/**
 * The colour dialog: HSL sliders, the hex code, the 21 palette colours as shortcuts, a preview and
 * a status line with the contrast against the cards and any warnings (they never block saving).
 * Below the trigger, aligned to its right edge and kept inside the window; above it when it does
 * not fit. Esc, X, Cancel or a press outside close it without saving.
 */
function ColorPopup({ id, anchor, value, name, icon: Icon, onSave, onClose }: ColorPopupProps) {
  const t = useT()
  const language = useLanguage()
  const titleId = useId()
  const codeId = useId()
  const codeErrorId = useId()
  const shortcutsId = useId()
  const dialog = useRef<HTMLDivElement | null>(null)
  const hue = useRef<HTMLInputElement | null>(null)
  const swatches = useRef<(HTMLButtonElement | null)[]>([])
  const [draft, setDraft] = useState<Draft>(() => draftFromHex(colorHex(value)))
  const [code, setCode] = useState(draft.hex)
  const [codeTouched, setCodeTouched] = useState(false)
  // Until it is placed the popup is transparent, not `visibility: hidden`: a hidden element cannot
  // take focus, and WebView2 dropped the focus given to Hue before the placement was painted.
  const [position, setPosition] = useState<CSSProperties | null>(null)

  // Below the trigger, right edges aligned, clamped to the window; flipped above when it does not
  // fit. The popup is at most the window's height (its body scrolls), so when neither side has room
  // it is pinned inside the window. Placed again whenever it changes size (the hex error, a longer
  // warning), so a popup above the trigger grows upwards instead of covering it.
  useLayoutEffect(() => {
    const place = () => {
      const trigger = anchor.current
      const popup = dialog.current
      if (!trigger || !popup) return
      const width = Math.min(POPUP_WIDTH, window.innerWidth - 2 * MARGIN)
      const rect = trigger.getBoundingClientRect()
      const height = popup.offsetHeight
      const left = Math.min(Math.max(rect.right - width, MARGIN), window.innerWidth - width - MARGIN)
      let top = rect.bottom + GAP
      if (top + height > window.innerHeight - MARGIN && rect.top - GAP - height >= MARGIN) top = rect.top - GAP - height
      top = Math.max(MARGIN, Math.min(top, window.innerHeight - height - MARGIN))
      setPosition({ left, top, width })
    }
    place()
    const observer = new ResizeObserver(place)
    if (dialog.current) observer.observe(dialog.current)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchor])

  // Opening focuses Hue, once the popup is placed (and so visible).
  const placed = position !== null
  useEffect(() => {
    if (placed) hue.current?.focus()
  }, [placed])

  // A press outside (the trigger toggles on its own) or the window losing focus closes without saving.
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (dialog.current?.contains(target) || anchor.current?.contains(target)) return
      closeRef.current()
    }
    const onWindowBlur = () => closeRef.current()
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', onWindowBlur)
    }
  }, [anchor])

  const setFromHsl = (hsl: Hsl) => {
    const hex = hslToHex(hsl)
    setDraft({ hex, hsl })
    setCode(hex)
    setCodeTouched(false)
  }
  const setFromHex = (hex: string) => {
    setDraft(draftFromHex(hex))
    setCode(hex)
    setCodeTouched(false)
  }

  const onCodeChange = (event: ChangeEvent<HTMLInputElement>) => {
    const text = event.target.value
    setCode(text)
    const hex = normalizeHex(text)
    if (hex) setDraft(draftFromHex(hex))
  }
  const codeValid = normalizeHex(code) !== null
  // Incomplete input only counts as wrong once the field is left (or Enter); a stray character, at once.
  const codeInvalid = !codeValid && (codeTouched || /[^#0-9a-f\s]/i.test(code) || code.replace(/[#\s]/g, '').length > 6)

  const checked = paletteIdFor(draft.hex)
  const tabStop = radioTabStop(checked ? integrationColorIds.indexOf(checked) : -1)

  const onShortcutKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const focused = swatches.current.findIndex((swatch) => swatch === event.target)
    const to = radioKeyTarget(event.key, focused === -1 ? tabStop : focused, integrationColorIds.length)
    const id = to === null ? undefined : integrationColorIds[to]
    if (to === null || !id) return
    event.preventDefault()
    swatches.current[to]?.focus()
    setFromHex(INTEGRATION_COLOR_HEX[id])
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    // Tab stays inside the popup.
    if (event.key !== 'Tab' || !dialog.current) return
    const focusables = [...dialog.current.querySelectorAll<HTMLElement>('button, input')].filter(
      (element) => element.tabIndex >= 0 && !element.hasAttribute('disabled'),
    )
    const first = focusables[0]
    const last = focusables.at(-1)
    if (!first || !last) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const check = checkColor(draft.hex)
  const ratio = formatRatio(check.ratio, language)
  const warnings = [
    check.lowContrast ? t('cc.colorPicker.lowContrast', { ratio }) : null,
    check.nearAlert ? t('cc.colorPicker.nearAlert') : null,
    check.nearGray ? t('cc.colorPicker.nearGray') : null,
  ].filter((warning): warning is string => warning !== null)
  const status = warnings.length > 0 ? warnings.join(' ') : t('cc.colorPicker.ok', { ratio })

  const { h, s, l } = draft.hsl
  const sliders = [
    {
      key: 'h' as const,
      label: t('cc.colorPicker.hue'),
      max: 360,
      unit: '°',
      track: `linear-gradient(to right, ${[0, 60, 120, 180, 240, 300, 360].map((deg) => `hsl(${deg} ${s}% ${l}%)`).join(', ')})`,
    },
    {
      key: 's' as const,
      label: t('cc.colorPicker.saturation'),
      max: 100,
      unit: '%',
      track: `linear-gradient(to right, hsl(${h} 0% ${l}%), hsl(${h} 100% ${l}%))`,
    },
    {
      key: 'l' as const,
      label: t('cc.colorPicker.lightness'),
      max: 100,
      unit: '%',
      track: `linear-gradient(to right, hsl(${h} ${s}% 0%), hsl(${h} ${s}% 50%), hsl(${h} ${s}% 100%))`,
    },
  ]

  return (
    <div
      ref={dialog}
      id={id}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="color-popup"
      onKeyDown={onKeyDown}
      className="color-popup fixed z-50 flex flex-col"
      style={position ?? { opacity: 0 }}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-4 pb-3">
        <h2 id={titleId} className="truncate text-title font-medium text-chalk">
          {t('cc.colorPicker.title', { name })}
        </h2>
        <button
          type="button"
          aria-label={t('cc.colorPicker.close')}
          title={t('cc.colorPicker.close')}
          onClick={onClose}
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-control-sm text-graphite transition-colors duration-150 hover:bg-veil-hover hover:text-chalk"
        >
          <X size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>

      {/* The body scrolls when the window is shorter than the popup; header and footer stay. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-1">
        <div className="flex flex-col gap-3">
          {sliders.map((slider, index) => (
            <label key={slider.key} className="flex flex-col gap-1.5">
              <span className="flex items-center justify-between text-small">
                <span className="text-graphite">{slider.label}</span>
                <span className="tabular font-mono text-chalk">
                  {draft.hsl[slider.key]}
                  {slider.unit}
                </span>
              </span>
              <input
                ref={index === 0 ? hue : undefined}
                type="range"
                min={0}
                max={slider.max}
                step={1}
                value={draft.hsl[slider.key]}
                aria-valuetext={`${draft.hsl[slider.key]}${slider.unit}`}
                onChange={(event) => setFromHsl({ ...draft.hsl, [slider.key]: Number(event.target.value) })}
                className="hsl-slider"
                style={{ '--track': slider.track, '--thumb': draft.hex } as CSSProperties}
              />
            </label>
          ))}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={codeId} className="text-small text-graphite">
            {t('cc.colorPicker.code')}
          </label>
          <input
            id={codeId}
            type="text"
            value={code}
            spellCheck={false}
            autoComplete="off"
            maxLength={9}
            aria-invalid={codeInvalid || undefined}
            aria-describedby={codeInvalid ? codeErrorId : undefined}
            onChange={onCodeChange}
            onBlur={() => setCodeTouched(true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setCodeTouched(true)
            }}
            className="field h-8 w-32 px-2.5 font-mono text-body uppercase text-chalk outline-none transition-colors duration-150 focus:border-select/60 aria-invalid:border-fail/60"
          />
          {codeInvalid && (
            <span id={codeErrorId} className="text-small text-fail">
              {t('cc.colorPicker.codeError')}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <span id={shortcutsId} className="text-small text-graphite">
            {t('cc.colorPicker.shortcuts')}
          </span>
          <div role="radiogroup" aria-labelledby={shortcutsId} onKeyDown={onShortcutKeyDown} className="flex flex-wrap gap-[10px] p-1">
            {integrationColorIds.map((paletteId, index) => {
              const label = t(`color.${paletteId}`)
              return (
                <button
                  key={paletteId}
                  ref={(element) => {
                    swatches.current[index] = element
                  }}
                  type="button"
                  role="radio"
                  aria-checked={paletteId === checked}
                  aria-label={label}
                  title={label}
                  tabIndex={index === tabStop ? 0 : -1}
                  onClick={() => setFromHex(INTEGRATION_COLOR_HEX[paletteId])}
                  className={`color-shortcut size-[18px] shrink-0 grow-0 cursor-pointer rounded-full ${paletteId === checked ? 'color-shortcut-checked' : ''}`}
                  style={{ backgroundColor: INTEGRATION_COLOR_HEX[paletteId] }}
                />
              )
            })}
          </div>
        </div>

        <div className="flex items-center gap-3" aria-hidden="true" style={{ '--int': draft.hex } as CSSProperties}>
          {Icon && (
            <span
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-tile"
              style={{ backgroundColor: `color-mix(in srgb, ${draft.hex} 14%, transparent)`, color: draft.hex }}
            >
              <Icon size={16} strokeWidth={1.8} />
            </span>
          )}
          <span className="grid grid-flow-col grid-rows-3 gap-[3px]">
            {PREVIEW_LEVELS.map((level, index) => (
              <span key={index} className={`block size-[10px] rounded-[3px] ${LEVEL_FILL[level]}`} />
            ))}
          </span>
        </div>

        <p role="status" className={`text-small ${warnings.length > 0 ? 'text-chalk' : 'text-graphite'}`}>
          {status}
        </p>
      </div>

      <div className="flex shrink-0 justify-end gap-2 px-4 pt-3 pb-4">
        <button type="button" className="btn" onClick={onClose}>
          {t('cc.colorPicker.cancel')}
        </button>
        <button type="button" className="btn btn-primary" onClick={() => onSave(colorToStore(draft.hex))}>
          {t('cc.colorPicker.save')}
        </button>
      </div>
    </div>
  )
}
