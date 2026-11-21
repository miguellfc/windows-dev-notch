import { describe, expect, it } from 'vitest'
import { activePage, CARD_STEP, cardPages, landsOnTabStop, nextCardIndex, resolveTabStop, scrollForCard, snapLeft, VISIBLE_CARDS, wheelScroll } from '../../../src/renderer/notch/panel/card-row'

describe('landsOnTabStop', () => {
  it('takes an arrow key while no control has the focus', () => {
    expect(landsOnTabStop('ArrowLeft', false, true)).toBe(true)
    expect(landsOnTabStop('ArrowRight', false, true)).toBe(true)
  })

  it('stays out of the way of any other control', () => {
    expect(landsOnTabStop('ArrowRight', false, false)).toBe(false)
  })

  it('ignores other keys and modified arrows', () => {
    expect(landsOnTabStop('Enter', false, true)).toBe(false)
    expect(landsOnTabStop('ArrowDown', false, true)).toBe(false)
    expect(landsOnTabStop('ArrowRight', true, true)).toBe(false)
  })
})

describe('resolveTabStop', () => {
  it('starts on the first card', () => {
    expect(resolveTabStop(['a', 'b'], { key: null, index: 0 })).toEqual({ key: 'a', index: 0 })
  })

  it('follows its card when the list shifts', () => {
    expect(resolveTabStop(['b', 'c'], { key: 'c', index: 2 })).toEqual({ key: 'c', index: 1 })
    expect(resolveTabStop(['a', 'x', 'b'], { key: 'b', index: 1 })).toEqual({ key: 'b', index: 2 })
  })

  it('moves to the nearest card when its card goes', () => {
    expect(resolveTabStop(['a', 'c'], { key: 'b', index: 1 })).toEqual({ key: 'c', index: 1 })
    expect(resolveTabStop(['a', 'b'], { key: 'c', index: 2 })).toEqual({ key: 'b', index: 1 })
  })

  it('holds nothing with no cards left', () => {
    expect(resolveTabStop([], { key: 'a', index: 3 })).toEqual({ key: null, index: 0 })
  })

  it('returns the same stop when nothing changed', () => {
    const stop = { key: 'b', index: 1 }
    expect(resolveTabStop(['a', 'b'], stop)).toBe(stop)
  })
})

describe('card row constants', () => {
  it('steps by a 172 px card and its 10 px gap, and shows 3.5 cards', () => {
    expect(CARD_STEP).toBe(182)
    expect(VISIBLE_CARDS).toBe(3.5)
  })
})

describe('cardPages', () => {
  it('is one page up to three cards, then one more per card', () => {
    expect(cardPages(0)).toBe(1)
    expect(cardPages(3)).toBe(1)
    expect(cardPages(4)).toBe(2)
    expect(cardPages(8)).toBe(6)
  })
})

describe('activePage', () => {
  it('rounds the scroll to the nearest card', () => {
    expect(activePage(0, 6)).toBe(0)
    expect(activePage(182, 6)).toBe(1)
    expect(activePage(100, 6)).toBe(1)
    expect(activePage(90, 6)).toBe(0)
  })

  it('stays within the pages', () => {
    expect(activePage(5000, 6)).toBe(5)
    expect(activePage(-40, 6)).toBe(0)
  })

  it('knows the last page, which ends short of a whole step', () => {
    // Seven cards: the row stops at 0, 182, 364, 546 and 632, with the last card against the edge.
    expect(activePage(632, 5)).toBe(4)
    expect(activePage(546, 5)).toBe(3)
    expect(activePage(86, 2)).toBe(1)
  })
})

describe('wheelScroll', () => {
  it('turns the vertical wheel into horizontal scroll', () => {
    expect(wheelScroll(0, 100, 0, 500)).toEqual({ left: 100, consumed: true })
    expect(wheelScroll(0, -100, 200, 500)).toEqual({ left: 100, consumed: true })
  })

  it('uses deltaX when it dominates', () => {
    expect(wheelScroll(50, 10, 0, 500)).toEqual({ left: 50, consumed: true })
  })

  it('consumes nothing with nothing to scroll that way', () => {
    expect(wheelScroll(0, 100, 500, 500)).toEqual({ left: 500, consumed: false })
    expect(wheelScroll(0, -100, 0, 500)).toEqual({ left: 0, consumed: false })
    expect(wheelScroll(0, 100, 0, 0)).toEqual({ left: 0, consumed: false })
  })

  it('stops at the ends', () => {
    expect(wheelScroll(0, 100, 450, 500)).toEqual({ left: 500, consumed: true })
    expect(wheelScroll(0, -100, 50, 500)).toEqual({ left: 0, consumed: true })
  })
})

describe('snapLeft', () => {
  it('lands on the nearest card, within the row', () => {
    expect(snapLeft(90, 910)).toBe(0)
    expect(snapLeft(100, 910)).toBe(182)
    expect(snapLeft(2000, 910)).toBe(910)
  })

  it('reaches the end of the row, which is not a whole step away', () => {
    expect(snapLeft(632, 632)).toBe(632)
    expect(snapLeft(600, 632)).toBe(632)
    expect(snapLeft(560, 632)).toBe(546)
  })
})

describe('scrollForCard', () => {
  it('stays put while the card is whole in view', () => {
    expect(scrollForCard(0, 0, 632)).toBe(0)
    expect(scrollForCard(2, 0, 632)).toBe(0)
    expect(scrollForCard(3, 182, 632)).toBe(182)
  })

  it('brings in a card past the right edge as the third one shown', () => {
    expect(scrollForCard(3, 0, 632)).toBe(182)
  })

  it('stops at the end of the row for the last cards', () => {
    expect(scrollForCard(6, 0, 632)).toBe(632)
    expect(scrollForCard(5, 546, 632)).toBe(546)
    expect(scrollForCard(6, 546, 632)).toBe(632)
  })

  it('stays at the end while the last three cards are in view', () => {
    expect(scrollForCard(4, 632, 632)).toBe(632)
    expect(scrollForCard(6, 632, 632)).toBe(632)
  })

  it('brings in a card past the left edge as the first one shown', () => {
    expect(scrollForCard(1, 364, 632)).toBe(182)
    expect(scrollForCard(3, 632, 632)).toBe(546)
    expect(scrollForCard(0, 632, 632)).toBe(0)
  })
})

describe('nextCardIndex', () => {
  it('moves one card at a time', () => {
    expect(nextCardIndex(2, 'ArrowLeft', 8)).toBe(1)
    expect(nextCardIndex(2, 'ArrowRight', 8)).toBe(3)
  })

  it('never wraps around', () => {
    expect(nextCardIndex(0, 'ArrowLeft', 8)).toBe(0)
    expect(nextCardIndex(7, 'ArrowRight', 8)).toBe(7)
  })
})
