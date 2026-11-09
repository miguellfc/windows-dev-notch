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
  compact: { width: 168, height: 36 },
  peek: { width: 240, height: 40 },
  expanded: { width: 440, height: 196 },
  mini: { width: 120, height: 6 },
}

/** Transparent room around the capsule so its shadow is not clipped by the window edge. */
export const SHADOW_MARGIN = { side: 32, top: 6, bottom: 48 } as const

/** Window bounds for a mode: horizontally centred at the top of the given work area. */
export function windowBoundsFor(mode: VisibleMode, workArea: Rect): Rect {
  const capsule = CAPSULE_SIZES[mode]
  const width = capsule.width + SHADOW_MARGIN.side * 2
  const height = SHADOW_MARGIN.top + capsule.height + SHADOW_MARGIN.bottom
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y),
    width,
    height,
  }
}

const area = (mode: VisibleMode) => CAPSULE_SIZES[mode].width * CAPSULE_SIZES[mode].height

/**
 * Growing: enlarge the transparent window first, then animate inside it.
 * Shrinking: animate first, then shrink the window (M0 strategy A).
 */
export function resizeOrder(from: VisibleMode, to: VisibleMode): 'resize-first' | 'animate-first' {
  return area(to) >= area(from) ? 'resize-first' : 'animate-first'
}
