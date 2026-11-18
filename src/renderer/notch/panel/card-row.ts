/** A 172 px card and the 10 px gap after it. */
export const CARD_STEP = 182

/** The row shows three cards and half of the fourth, which says there are more. */
export const VISIBLE_CARDS = 3.5

/** Cards whole in view at once: the last page shows the last three. */
const WHOLE_CARDS = 3

/** Scroll positions of the row: one per card that can come first, with three cards shown. */
export function cardPages(count: number): number {
  return count <= WHOLE_CARDS ? 1 : count - 2
}

/** The page a scroll position belongs to. */
export function activePage(scrollLeft: number, pages: number): number {
  return Math.min(Math.max(Math.round(scrollLeft / CARD_STEP), 0), pages - 1)
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

/** The card position nearest to a scroll position, within the row. */
export function snapLeft(left: number, maxScroll: number): number {
  return Math.min(Math.round(left / CARD_STEP) * CARD_STEP, maxScroll)
}

/** The scroll that shows a card whole, moving the row only if it has to. */
export function scrollForCard(index: number, scrollLeft: number): number {
  const first = Math.round(scrollLeft / CARD_STEP)
  if (index < first) return index * CARD_STEP
  if (index > first + WHOLE_CARDS - 1) return (index - WHOLE_CARDS + 1) * CARD_STEP
  return first * CARD_STEP
}

/** The card an arrow key moves to; the ends stop it. */
export function nextCardIndex(index: number, key: 'ArrowLeft' | 'ArrowRight', count: number): number {
  return key === 'ArrowLeft' ? Math.max(index - 1, 0) : Math.min(index + 1, count - 1)
}
