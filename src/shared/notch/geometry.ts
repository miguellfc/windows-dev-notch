import type { NotchMode } from './state'

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type VisibleMode = Exclude<NotchMode, 'hidden'>

/**
 * The home panel, one size whatever it lists. Wide enough for the quick-access column and 3.5 cards:
 * 12 + 44 + 10 + (3.5 × 172 + 3 × 10) + 12 + 2 of border. Tall enough for the header, the cards, the
 * page indicator and the help line: 14 + 28 + 10 + 196 + 8 + 4 + 8 + 20 + 10 + 2 of border.
 */
export const EXPANDED_SIZE = { width: 712, height: 300 } as const

/**
 * The Gmail panel: the list (5 rows of 58 px, measured with Playwright: no gap, no scroll) and the
 * reader of one message (measured with Playwright on long mail: the header and the footer never
 * clip, the body scrolls). Both are the `gmail` mode; the window is sized for the reader, and the
 * list is a shorter capsule inside it.
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
 * footer never clip. Taller than every panel but "Revisiones": the window grows for it (resize first).
 */
export const QUESTION_SIZE = { width: 520, height: 504 } as const

/**
 * The "Revisiones" panel, measured with Playwright in ES and EN (built app, 6-column month, worst
 * case with the partial-data, private-contributions and error lines): a fixed 32 px header (back,
 * title, the platform name, refresh); under it the contributions block (the 114 px month chart
 * column beside the summary table, 199-235 px tall) and then "Por revisar" and "Míos" in their own
 * scroll (28 px heading, 50 px rows), which keeps 297 px (a heading and five rows) in the usual case and about
 * four rows in the worst one; the header and the chart never clip. The tallest panel (taller than
 * the question card): the window grows before it opens (resize first) and shrinks after it closes.
 */
export const REVIEWS_SIZE = { width: 520, height: 560 } as const

/**
 * The Redmine view, the same size as "Revisiones" (so moving between them never resizes the window):
 * the 32 px header, the hours summary (the month chart beside Hoy · Semana · Mes), the search box,
 * then the assigned issues (50 px rows) or one issue's detail in their own scroll.
 */
export const REDMINE_SIZE = { width: 520, height: 560 } as const

/**
 * The zones of the compact capsule (time and date | integration blocks | system), in px, measured
 * with `getBoundingClientRect` in the real WebView2 (debug e2e build) in ES and EN, every value at
 * its reserved width ("100 %", "W: 100 %", "99+", "23,75h", 4 dots and "+9"); each is the worst of
 * the two languages. Every slot carries its own 10 px gap before it, so the zones add up exactly.
 */
export const COMPACT_ZONE = {
  /** The horizontal padding (14 px each side) and the capsule's 1 px border on each side. */
  padding: 30,
  /** The 1 px line and the room around it (12 px before, 2 px after; the next slot adds its 10). */
  divider: 15,
  /**
   * Time and date: EN, "12:59 AM" (62.4) + 10 + "Wed, May 20" (74.6) = 147.0, rounded up (ES: "00:59",
   * "dom, 20 sept", 124.3). The worst of every hour and every day of a year.
   */
  left: 147,
  /** CPU, RAM, storage and connection, without the battery: ES 63.5 + 63.5 + 86 + 22 (EN 212.5). */
  system: 235,
  /** What the battery adds, with its gap: ES 63.5 (EN 56). */
  battery: 63.5,
} as const

/** Each integration block of the compact capsule with its 10 px gap, in px (measured like COMPACT_ZONE, the same in ES and EN). */
export const CAPSULE_BLOCK = {
  /** Claude's mark, 4 dots and "+9". */
  claude: 97,
  /** Gmail's mark and "99+". */
  mail: 48.5,
  /** One code-review platform's mark and "99+". */
  review: 48.5,
  /** Redmine's mark and "23,75h" / "23.75h". */
  redmine: 71,
} as const

/** What the compact capsule shows: the system zone (null: no sample) and the integration blocks. */
export interface CompactContent {
  system: { battery: boolean } | null
  blocks: { claude: boolean; mail: boolean; reviews: 0 | 1 | 2; redmine: boolean }
}

/**
 * Width of the compact capsule: time and date always; the integration blocks after a divider when
 * there is one; the system zone after another divider while there is a sample. Alerts (a low disk
 * included) only change colours, never the width.
 */
export function compactWidthFor({ system, blocks }: CompactContent): number {
  let width = COMPACT_ZONE.padding + COMPACT_ZONE.left
  const middle =
    (blocks.claude ? CAPSULE_BLOCK.claude : 0) +
    (blocks.mail ? CAPSULE_BLOCK.mail : 0) +
    blocks.reviews * CAPSULE_BLOCK.review +
    (blocks.redmine ? CAPSULE_BLOCK.redmine : 0)
  if (middle > 0) width += COMPACT_ZONE.divider + middle
  if (system) width += COMPACT_ZONE.divider + COMPACT_ZONE.system + (system.battery ? COMPACT_ZONE.battery : 0)
  return Math.ceil(width)
}

/**
 * Size of the visible capsule per mode, in DIP. `compact` is its usual content (time and date, then
 * the system zone with a battery; the renderer sizes it with {@link compactWidthFor}). `peek` is the
 * resting capsule: the compact capsule's time-and-date zone alone (`ceil(padding + left)`) at the
 * compact height, so hovering into compact only widens it and never resizes the window. `mini` is the pill the user pins with a
 * right click: 4 px tall, flush against the top edge of the screen ({@link capsuleTopFor}), where the
 * edge stops the pointer, so it stays easy to hit while covering a 96×4 strip of what is under it.
 */
export const CAPSULE_SIZES: Readonly<Record<VisibleMode, { width: number; height: number }>> = {
  compact: { width: 491, height: 36 },
  peek: { width: 177, height: 36 },
  alert: { width: 320, height: 44 },
  expanded: EXPANDED_SIZE,
  permission: { width: 480, height: 300 },
  question: QUESTION_SIZE,
  reminders: { width: 420, height: 320 },
  system: { width: 520, height: 280 },
  notes: { width: 420, height: 320 },
  gmail: GMAIL_SIZES.reader,
  reviews: REVIEWS_SIZE,
  redmine: REDMINE_SIZE,
  mini: { width: 96, height: 4 },
}

/**
 * Transparent room around the capsule so its shadow is not clipped by the window edge. The
 * levitation shadow (`0 18px 50px`) reaches 50 px sideways and 18 + 50 px below the capsule.
 */
export const SHADOW_MARGIN = { side: 56, top: 6, bottom: 72 } as const

/** The widest the compact capsule gets: every integration block (both code-review ones), the system zone and the battery. */
export const WIDEST_COMPACT_WIDTH = compactWidthFor({
  system: { battery: true },
  blocks: { claude: true, mail: true, reviews: 2, redmine: true },
})

/**
 * Constant window width: the widest capsule (a panel, or the compact capsule with every block
 * showing) plus its shadow. The width never changes between modes because Motion suspends layout
 * animations for 250 ms whenever `innerWidth` changes, which turned every growing morph into a
 * jump. Only the height follows the mode. Rounded up to an even number so the window centres
 * on the screen without a half pixel: the widest compact capsule (819 px) makes it 932.
 */
export const WINDOW_WIDTH = Math.ceil((Math.max(WIDEST_COMPACT_WIDTH, ...Object.values(CAPSULE_SIZES).map((size) => size.width)) + SHADOW_MARGIN.side * 2) / 2) * 2

/**
 * Distance from the window's top to the capsule: the shadow room above it, except for the pinned mini,
 * which sits flush against the top edge of the screen (its low shadow only falls below it).
 */
export function capsuleTopFor(mode: VisibleMode): number {
  return mode === 'mini' ? 0 : SHADOW_MARGIN.top
}

/** Window height for a mode: the capsule plus the shadow room above (see {@link capsuleTopFor}) and below it. */
export function windowHeightFor(mode: VisibleMode): number {
  return capsuleTopFor(mode) + CAPSULE_SIZES[mode].height + SHADOW_MARGIN.bottom
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
