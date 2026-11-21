/** The seven configurable integrations, in the order the Control Center lists them. */
export const integrationKeys = ['claude', 'github', 'gitlab', 'gmail', 'redmine', 'reminders', 'notes'] as const
export type IntegrationKey = (typeof integrationKeys)[number]

/** Only these can show a block in the capsule. */
export const capsuleIntegrationKeys = ['claude', 'github', 'gitlab', 'gmail', 'redmine'] as const
export type CapsuleIntegrationKey = (typeof capsuleIntegrationKeys)[number]

/** The 21 palette ids (ASCII), in display order. */
export const integrationColorIds = [
  'pistachio',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'cobalt',
  'indigo',
  'violet',
  'lavender',
  'plum',
  'fuchsia',
  'pink',
  'salmon',
  'peach',
  'orange',
  'amber',
  'clay',
  'sand',
] as const
export type PaletteColor = (typeof integrationColorIds)[number]

/** A custom color: uppercase `#RRGGBB`. */
export const HEX_COLOR = /^#[0-9A-F]{6}$/

/** A stored integration color: a palette id, or a custom uppercase `#RRGGBB`. */
export type IntegrationColor = PaletteColor | `#${string}`

export const INTEGRATION_COLOR_HEX: Readonly<Record<PaletteColor, string>> = {
  pistachio: '#D9F99D',
  lime: '#A3E635',
  green: '#4ADE80',
  emerald: '#10B981',
  teal: '#2DD4BF',
  cyan: '#22D3EE',
  sky: '#38BDF8',
  blue: '#7DD3FC',
  cobalt: '#60A5FA',
  indigo: '#818CF8',
  violet: '#A78BFA',
  lavender: '#C4B5FD',
  plum: '#C084FC',
  fuchsia: '#E879F9',
  pink: '#F472B6',
  salmon: '#FDA4AF',
  peach: '#FDBA74',
  orange: '#FB923C',
  amber: '#FBBF24',
  clay: '#CC785C',
  sand: '#D6C7A1',
}

export const DEFAULT_INTEGRATION_COLORS: Readonly<Record<IntegrationKey, PaletteColor>> = {
  claude: 'clay',
  github: 'green',
  gitlab: 'orange',
  gmail: 'salmon',
  redmine: 'pink',
  reminders: 'blue',
  notes: 'violet',
}

const paletteIds: ReadonlySet<string> = new Set(integrationColorIds)

export function isPaletteColor(color: string): color is PaletteColor {
  return paletteIds.has(color)
}

/** The color as uppercase `#RRGGBB`: a palette id gives its hex, a hex gives itself. */
export function colorHex(color: IntegrationColor): string {
  return isPaletteColor(color) ? INTEGRATION_COLOR_HEX[color] : color
}

/** The palette id whose hex is `hex` (any case), or null. */
export function paletteIdFor(hex: string): PaletteColor | null {
  const upper = hex.toUpperCase()
  return integrationColorIds.find((id) => INTEGRATION_COLOR_HEX[id] === upper) ?? null
}
