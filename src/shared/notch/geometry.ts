import type { NotchMode } from './state'

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type VisibleMode = Exclude<NotchMode, 'hidden'>

/** Size of the visible capsule per mode, in DIP. */
export const CAPSULE_SIZES: Readonly<Record<VisibleMode, { width: number; height: number }>> = {
  compact: { width: 358, height: 36 },
  peek: { width: 240, height: 40 },
  alert: { width: 320, height: 44 },
  expanded: { width: 440, height: 236 },
  terminal: { width: 640, height: 360 },
  permission: { width: 480, height: 300 },
  reminders: { width: 420, height: 320 },
  system: { width: 520, height: 280 },
  mini: { width: 120, height: 6 },
}

/**
 * Compact capsule widths by content, measured with Playwright in ES and EN (worst time and date,
 * every value at its reserved "100 %" width). `CAPSULE_SIZES.compact` is the usual one (time, date,
 * CPU, RAM and battery); without a battery its slot is dropped, and with no sample yet or the
 * monitor unavailable the capsule keeps its original time-and-date width. The low-disk block
 * (reserving "W: 100 %", the widest drive letter) only exists while that alert is latched:
 * EN 374.7 px without a battery and 433.8 px with one.
 */
export const COMPACT_WIDTHS = {
  plain: 168,
  metrics: 299,
  metricsBattery: CAPSULE_SIZES.compact.width,
  metricsDisk: 376,
  metricsBatteryDisk: 435,
} as const

/**
 * Width of the compact capsule for what it shows: null is time and date only. Alerts only change
 * colours, never the width; the low-disk block is the one alert that adds a slot.
 */
export function compactWidthFor(content: { battery: object | null; disk: object | null } | null): number {
  if (!content) return COMPACT_WIDTHS.plain
  if (content.disk) return content.battery ? COMPACT_WIDTHS.metricsBatteryDisk : COMPACT_WIDTHS.metricsDisk
  return content.battery ? COMPACT_WIDTHS.metricsBattery : COMPACT_WIDTHS.metrics
}

/**
 * Transparent room around the capsule so its shadow is not clipped by the window edge. The
 * levitation shadow (`0 18px 50px`) reaches 50 px sideways and 18 + 50 px below the capsule.
 */
export const SHADOW_MARGIN = { side: 56, top: 6, bottom: 72 } as const

/**
 * Constant window width: the widest capsule plus its shadow. The width never changes between
 * modes because Motion suspends layout animations for 250 ms whenever `innerWidth` changes,
 * which turned every growing morph into a jump. Only the height follows the mode.
 */
export const WINDOW_WIDTH = Math.max(...Object.values(CAPSULE_SIZES).map((size) => size.width)) + SHADOW_MARGIN.side * 2

/** Window height for a mode: the capsule plus the shadow room above and below it. */
export function windowHeightFor(mode: VisibleMode): number {
  return SHADOW_MARGIN.top + CAPSULE_SIZES[mode].height + SHADOW_MARGIN.bottom
}

/** Window bounds for a mode: fixed width, horizontally centred at the top of the given work area. */
export function windowBoundsFor(mode: VisibleMode, workArea: Rect): Rect {
  const width = WINDOW_WIDTH
  const height = windowHeightFor(mode)
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y),
    width,
    height,
  }
}

/**
 * Whether a change grows the window. Only the height changes between modes, so this is the
 * single rule for the window order (main) and the grow/shrink motion (renderer). Area would
 * disagree for reminders (420×320) ↔ permission (480×300).
 */
export function growsWindow(from: VisibleMode, to: VisibleMode): boolean {
  return windowHeightFor(to) >= windowHeightFor(from)
}

/**
 * Growing: enlarge the transparent window (its height) first, then animate inside it.
 * Shrinking: animate first, then shrink the window (M0 strategy A).
 */
export function resizeOrder(from: VisibleMode, to: VisibleMode): 'resize-first' | 'animate-first' {
  return growsWindow(from, to) ? 'resize-first' : 'animate-first'
}
