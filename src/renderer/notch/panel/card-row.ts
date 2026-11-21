/** A 172 px card and the 10 px gap after it. */
export const CARD_STEP = 182

/** The row shows three cards and half of the fourth, which says there are more. */
export const VISIBLE_CARDS = 3.5

/** Cards whole in view at once: the last page shows the last three. */
const WHOLE_CARDS = 3

/** How much sooner than a whole step the row ends: the half card in view (86 px) and its 10 px gap. */
const END_SHORTFALL = 96

/** Scroll positions of the row: one per card that can come first, with three cards shown. */
export function cardPages(count: number): number {
  return count <= WHOLE_CARDS ? 1 : count - 2
}

/** Where the row ends: the last card against the right edge. */
function endOfRow(pages: number): number {
  return pages <= 1 ? 0 : (pages - 1) * CARD_STEP - END_SHORTFALL
}

/** The page a scroll position belongs to. */
export function activePage(scrollLeft: number, pages: number): number {
  const end = endOfRow(pages)
  const left = snapLeft(Math.max(scrollLeft, 0), end)
  return left === end ? pages - 1 : Math.round(left / CARD_STEP)
}

/**
 * Where a wheel event takes the row: the vertical wheel scrolls it sideways unless the horizontal
 * delta dominates. `consumed` is false with nothing to scroll that way.
 */
export function wheelScroll(deltaX: number, deltaY: number, scrollLeft: number, maxScroll: number): { left: number; consumed: boolean } {
  const delta = Math.abs(deltaY) > Math.abs(deltaX) ? deltaY : deltaX
  const left = Math.min(Math.max(scrollLeft + delta, 0), maxScroll)
  return { left, consumed: left !== scrollLeft }
}

/** The stop nearest to a scroll position: a whole step, or the end of the row, which may fall between two. */
export function snapLeft(left: number, maxScroll: number): number {
  const lastStep = Math.floor(maxScroll / CARD_STEP) * CARD_STEP
  if (left >= (lastStep + maxScroll) / 2) return maxScroll
  return Math.min(Math.round(left / CARD_STEP) * CARD_STEP, lastStep)
}

/** The scroll that shows a card whole, moving the row only if it has to. */
export function scrollForCard(index: number, scrollLeft: number, maxScroll: number): number {
  // The first card whole in view; at the end of the row the one before it is cut in half.
  const first = Math.max(Math.ceil((scrollLeft - 1) / CARD_STEP), 0)
  if (index < first) return index * CARD_STEP
  if (index > first + WHOLE_CARDS - 1) return Math.min((index - WHOLE_CARDS + 1) * CARD_STEP, maxScroll)
  return Math.min(first * CARD_STEP, maxScroll)
}

/**
 * Whether a key pressed anywhere in the panel lands on the row's Tab stop: a plain arrow while no
 * control has the focus, so the keys the help line announces work as soon as the panel opens.
 */
export function landsOnTabStop(key: string, modified: boolean, focusIsFree: boolean): boolean {
  return (key === 'ArrowLeft' || key === 'ArrowRight') && !modified && focusIsFree
}

/** The card that holds the row's Tab stop, and where it stood. */
export interface TabStop<K> {
  key: K | null
  index: number
}

/**
 * The Tab stop over the cards showing now: it follows its card when the list shifts and, if the card
 * has gone, moves to the one that took its place (the last card, if it was past the end).
 */
export function resolveTabStop<K>(keys: readonly K[], stop: TabStop<K>): TabStop<K> {
  const found = stop.key === null ? -1 : keys.indexOf(stop.key)
  const index = found >= 0 ? found : Math.max(Math.min(stop.index, keys.length - 1), 0)
  const key = keys[index] ?? null
  return key === stop.key && index === stop.index ? stop : { key, index }
}

/** The card an arrow key moves to; the ends stop it. */
export function nextCardIndex(index: number, key: 'ArrowLeft' | 'ArrowRight', count: number): number {
  return key === 'ArrowLeft' ? Math.max(index - 1, 0) : Math.min(index + 1, count - 1)
}
