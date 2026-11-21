import { paletteIdFor, type IntegrationColor } from '../../shared/integrations/colors'

/** HSL with integer components: hue 0-360 (degrees), saturation and lightness 0-100 (%). */
export interface Hsl {
  h: number
  s: number
  l: number
}

type Rgb = readonly [number, number, number]

const map3 = (rgb: Rgb, f: (channel: number) => number): Rgb => [f(rgb[0]), f(rgb[1]), f(rgb[2])]

/** `#RRGGBB` (any case) to 0-255 channels. */
function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`.toUpperCase()
}

/**
 * What the user typed in the code field, as uppercase `#RRGGBB`: six hex digits with or without
 * `#`, any case, surrounding spaces ignored. Anything else gives null.
 */
export function normalizeHex(text: string): string | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(text.trim())
  return match ? `#${match[1]!.toUpperCase()}` : null
}

export function hslToHex({ h, s, l }: Hsl): string {
  const sat = s / 100
  const light = l / 100
  const chroma = (1 - Math.abs(2 * light - 1)) * sat
  const hue = (((h % 360) + 360) % 360) / 60
  const x = chroma * (1 - Math.abs((hue % 2) - 1))
  const [r, g, b]: Rgb =
    hue < 1 ? [chroma, x, 0] : hue < 2 ? [x, chroma, 0] : hue < 3 ? [0, chroma, x] : hue < 4 ? [0, x, chroma] : hue < 5 ? [x, 0, chroma] : [chroma, 0, x]
  const m = light - chroma / 2
  return rgbToHex([(r + m) * 255, (g + m) * 255, (b + m) * 255])
}

/** `#RRGGBB` to HSL, rounded to whole degrees and percents (the sliders' steps). */
export function hexToHsl(hex: string): Hsl {
  const [r, g, b] = map3(hexToRgb(hex), (c) => c / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l: Math.round(l * 100) }
  const s = d / (1 - Math.abs(2 * l - 1))
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { h: Math.round(h * 60) % 360, s: Math.round(s * 100), l: Math.round(l * 100) }
}

function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = map3(rgb, (c) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two colours (1-21). */
function contrastRgb(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** `--color-obsidian-dense` and the alpha of `--color-veil` (white): a card is the veil over it. */
export const OBSIDIAN_DENSE = '#050506'
export const VEIL_ALPHA = 0.056

/** The card surface the integration colour sits on: Velo (white at 5.6 %) over Obsidiana Densa. */
export const CARD_RGB: Rgb = map3(hexToRgb(OBSIDIAN_DENSE), (c) => c + (255 - c) * VEIL_ALPHA)

/** Contrast of `hex` against the card surface. */
export function cardContrast(hex: string): number {
  return contrastRgb(hexToRgb(hex), CARD_RGB)
}

/** Coral Espera and Rojo Fallo: an integration colour too close to them reads as an alert. */
export const ALERT_COLORS = ['#FF8A7A', '#F87171'] as const
export const MIN_CARD_CONTRAST = 3
export const MIN_ALERT_DISTANCE = 70
export const MIN_SATURATION = 15

export interface ColorCheck {
  /** Contrast against the card, unrounded. */
  ratio: number
  lowContrast: boolean
  nearAlert: boolean
  nearGray: boolean
}

/** The warnings for a draft colour. They inform; none of them blocks saving. */
export function checkColor(hex: string): ColorCheck {
  const rgb = hexToRgb(hex)
  const ratio = cardContrast(hex)
  const distance = (other: string) => {
    const [r, g, b] = hexToRgb(other)
    return Math.hypot(r - rgb[0], g - rgb[1], b - rgb[2])
  }
  return {
    ratio,
    lowContrast: ratio < MIN_CARD_CONTRAST,
    // The palette was already vetted against coral and red (OKLab >= 0.07): only custom colours get the note.
    nearAlert: paletteIdFor(hex) === null && ALERT_COLORS.some((alert) => distance(alert) < MIN_ALERT_DISTANCE),
    nearGray: hexToHsl(hex).s < MIN_SATURATION,
  }
}

/** The ratio with one decimal, cut (never rounded up past a threshold): `2,9` in Spanish, `2.9` in English. */
export function formatRatio(ratio: number, language: 'es' | 'en'): string {
  const text = (Math.floor(ratio * 10) / 10).toFixed(1)
  return language === 'es' ? text.replace('.', ',') : text
}

/** What to store for a saved hex: the palette id when it is exactly a palette colour, else the hex. */
export function colorToStore(hex: string): IntegrationColor {
  return paletteIdFor(hex) ?? (hex.toUpperCase() as `#${string}`)
}
