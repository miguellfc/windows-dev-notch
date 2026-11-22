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
 * The "Revisiones" panel, measured in WebView2 (built debug app, ES and EN, GitHub and GitLab) with
 * the worst case: the 114 px month chart beside the summary table, with the private-contributions,
 * partial-data and error lines and the offline footer. A fixed 32 px header (back, platform name,
 * refresh), the contributions block (202 px), the 32 px account row and the 20 px footer come to
 * 322 px of content, plus the capsule's 2 px border. It is no longer the tallest panel (Redmine is):
 * the window grows before it opens (resize first) from the shorter ones and shrinks after it closes.
 */
export const REVIEWS_SIZE = { width: 520, height: 324 } as const

/**
 * Size of the "Revisiones" capsule: with contributions, the view's own height plus the 2 px border
 * (no empty room under the account row), never taller than the window's panel; else the full panel.
 */
export function reviewsSizeFor(viewHeight: number | null): { width: number; height: number } {
  if (viewHeight === null) return REVIEWS_SIZE
  return { width: REVIEWS_SIZE.width, height: Math.min(viewHeight + 2, REVIEWS_SIZE.height) }
}

/**
 * The Redmine view. At rest, the 32 px header, the hours summary (the month chart beside
 * Hoy · Semana · Mes) and the search box. While searching, the summary shrinks to one line and the
 * matches or one issue's detail take the room below the box. Both are the `redmine` mode: the window
 * is sized for the search, the tallest panel, and the rest is a shorter capsule inside it. The rest
 * was measured in WebView2 (built debug app, ES and EN) with the worst case, the hours error line and
 * the offline footer: 8 + 32 + 6 + 154 (summary) + 6 + 28 (search) + 6 + 20 (footer) + 10, plus the
 * capsule's 2 px border.
 */
export const REDMINE_SIZES = {
  rest: { width: 520, height: 272 },
  search: { width: 520, height: 560 },
} as const

/**
 * Size of the Redmine panel: the search while there is something under the box, else the rest. When
 * the view reports its own height (at rest, or a short list of matches), the capsule fits it plus the
 * 2 px border (no empty room under the content), never taller than that size.
 */
export function redmineSizeFor(searching: boolean, viewHeight: number | null = null): { width: number; height: number } {
  const full = searching ? REDMINE_SIZES.search : REDMINE_SIZES.rest
  if (viewHeight === null) return full
  return { width: full.width, height: Math.min(viewHeight + 2, full.height) }
}

/**
 * The zones of the compact capsule (time and date | integration blocks | system), in px, measured
 * with `getBoundingClientRect` in the real WebView2 (debug e2e build) in ES and EN, every value at
 * its reserved width ("100 %", "99+", "999+", "744,75h", 4 dots and "+9"); each is the worst of
 * the two languages. Every slot carries its own 10 px gap before it, so the zones add up exactly.
 */
export const COMPACT_ZONE = {
  /** The horizontal padding (14 px each side) and the capsule's 1 px border on each side. */
  padding: 30,
  /** The 1 px line and the room around it (12 px before, 2 px after; the next slot adds its 10). */
  divider: 15,
  /**
   * Time (Nunito) and date: EN, "12:00 AM" (58.3) + 10 + "Wed, May 13" (75.0) = 143.3, rounded up
   * (ES: "00:00", "dom, 13 sept", 117.7). The worst of every hour and every day of a year.
   */
  left: 143.5,
  /** CPU, RAM, storage (Nunito figures, "100 %") and connection, without the battery: ES 63.4 + 63.4 + 63.4 + 22 = 212.3 (EN 202.5). */
  system: 212.5,
  /** What the battery adds, with its gap: ES 63.4 (EN 60.2). */
  battery: 63.5,
} as const

/** Each integration block of the compact capsule with its 10 px gap, in px (measured like COMPACT_ZONE, the same in ES and EN). */
export const CAPSULE_BLOCK = {
  /** Claude's 12 px mark alone. */
  claude: 22,
  /** Gmail's mark and "99+". */
  mail: 48.5,
  /** One code-review platform's mark and its contributions this month, "999+" (ES and EN alike: 46 + 10). */
  review: 56,
  /** Redmine's mark and the month's hours, "744,75h" / "744.75h". */
  redmine: 78.5,
} as const

/**
 * The widest peek: the time and date at their widest and Claude's mark after them (while some session
 * has a dot). The peek fits what it shows; this is its ceiling.
 */
export const PEEK_MAX_WIDTH = Math.ceil(COMPACT_ZONE.padding + COMPACT_ZONE.left + CAPSULE_BLOCK.claude)

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
  compact: { width: 465, height: 36 },
  peek: { width: 174, height: 36 },
  alert: { width: 320, height: 44 },
  expanded: EXPANDED_SIZE,
  permission: { width: 480, height: 300 },
  question: QUESTION_SIZE,
  reminders: { width: 420, height: 320 },
  notes: { width: 420, height: 320 },
  gmail: GMAIL_SIZES.reader,
  reviews: REVIEWS_SIZE,
  redmine: REDMINE_SIZES.search,
  // Same size as Redmine until the work log view sizes itself.
  workLog: REDMINE_SIZES.search,
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
 * on the screen without a half pixel: the widest compact capsule (741 px) makes it 854.
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
