import type { NotchMode } from './state'

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type VisibleMode = Exclude<NotchMode, 'hidden'>

/**
 * Heights of the home panel (integrations row), measured with Playwright: Claude sessions get
 * their own line under the tiles (12 px gap, 12 px heading and one 24 px row per session, two
 * visible, the rest scroll). The window height follows the mode (the question
 * card, 520×504 in a 582 px window, is the tallest panel); with fewer sessions the capsule is
 * shorter inside its window, like the compact capsule is narrower than the window, and the
 * transparent strip below lets clicks through (the window ignores the mouse outside the capsule).
 */
export const EXPANDED_HEIGHTS = { plain: 236, oneSession: 284, sessions: 308 } as const

/** Height of the home panel for the number of Claude sessions it lists: no gap, no empty row. */
export function expandedHeightFor(sessions: number): number {
  if (sessions <= 0) return EXPANDED_HEIGHTS.plain
  return sessions === 1 ? EXPANDED_HEIGHTS.oneSession : EXPANDED_HEIGHTS.sessions
}

/**
 * The Gmail panel: the list (5 rows of 58 px, measured with Playwright: no gap, no scroll) and the
 * reader of one message (measured with Playwright on long mail: the header and the footer never
 * clip, the body scrolls). Both are the `gmail` mode; the window is sized for the reader, and the
 * list is a shorter capsule inside it (like the home panel without sessions).
 */
export const GMAIL_SIZES = {
  list: { width: 420, height: 382 },
  reader: { width: 520, height: 440 },
} as const

/** Size of the Gmail panel: the reader while a message is open, else the list. */
export function gmailSizeFor(reading: boolean): { width: number; height: number } {
  return reading ? GMAIL_SIZES.reader : GMAIL_SIZES.list
}

/**
 * The Claude question card (`QuestionCard`), measured with Playwright on the built app: 137 px of
 * header and footer around the questions' own scroll. One question with 4 options whose
 * descriptions take two lines, one picked and "Other…" open with its field, needs 367 px of body,
 * so it shows whole (ES and EN alike); 4 questions scroll inside the body and the header and the
 * footer never clip. The tallest panel: the window grows for it (resize first, then animate).
 */
export const QUESTION_SIZE = { width: 520, height: 504 } as const

/** Size of the visible capsule per mode, in DIP. */
export const CAPSULE_SIZES: Readonly<Record<VisibleMode, { width: number; height: number }>> = {
  compact: { width: 358, height: 36 },
  peek: { width: 240, height: 40 },
  alert: { width: 320, height: 44 },
  expanded: { width: 440, height: EXPANDED_HEIGHTS.sessions },
  terminal: { width: 640, height: 360 },
  permission: { width: 480, height: 300 },
  question: QUESTION_SIZE,
  reminders: { width: 420, height: 320 },
  system: { width: 520, height: 280 },
  notes: { width: 420, height: 320 },
  gmail: GMAIL_SIZES.reader,
  mini: { width: 120, height: 6 },
}

/**
 * Compact capsule widths by content, measured with Playwright in ES and EN (worst time and date,
 * every value at its reserved "100 %" width). `CAPSULE_SIZES.compact` is the usual one (time, date,
 * CPU, RAM and battery); without a battery its slot is dropped, and with no sample yet or the
 * monitor unavailable the capsule keeps its original time-and-date width. The low-disk block
 * (reserving "W: 100 %", the widest drive letter) only exists while that alert is latched:
 * EN 374.7 px without a battery and 433.8 px with one. The unread-mail block (`Mail` + "99+", its
 * widest value) goes last and only exists while unread mail is latched: it measures 38.3 px in ES
 * and EN and adds 48.3 px after the metrics (its 10 px gap) or 52.3 px after time and date (that
 * layout's wider gaps); each variant is its width without mail plus that, rounded up (worst case
 * EN, battery, disk and "99+": 482.1 px).
 */
export const COMPACT_WIDTHS = {
  plain: 168,
  metrics: 299,
  metricsBattery: CAPSULE_SIZES.compact.width,
  metricsDisk: 376,
  metricsBatteryDisk: 435,
  plainMail: 221,
  metricsMail: 348,
  metricsBatteryMail: 407,
  metricsDiskMail: 425,
  metricsBatteryDiskMail: 484,
} as const

/**
 * Width of the compact capsule for what it shows: null is time and date only; `mail` adds the
 * unread-mail block. Alerts only change colours, never the width; the low-disk block is the one
 * alert that adds a slot.
 */
export function compactWidthFor(content: { battery: object | null; disk: object | null } | null, mail = false): number {
  if (!content) return mail ? COMPACT_WIDTHS.plainMail : COMPACT_WIDTHS.plain
  if (content.disk) {
    if (content.battery) return mail ? COMPACT_WIDTHS.metricsBatteryDiskMail : COMPACT_WIDTHS.metricsBatteryDisk
    return mail ? COMPACT_WIDTHS.metricsDiskMail : COMPACT_WIDTHS.metricsDisk
  }
  if (content.battery) return mail ? COMPACT_WIDTHS.metricsBatteryMail : COMPACT_WIDTHS.metricsBattery
  return mail ? COMPACT_WIDTHS.metricsMail : COMPACT_WIDTHS.metrics
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
