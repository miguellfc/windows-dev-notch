import { describe, expect, it } from 'vitest'
import { activePage, CARD_STEP, cardPages, nextCardIndex, scrollForCard, snapLeft, VISIBLE_CARDS, wheelScroll } from '../../../src/renderer/notch/panel/card-row'

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
})

describe('scrollForCard', () => {
  it('stays put while the card is whole in view', () => {
    expect(scrollForCard(0, 0)).toBe(0)
    expect(scrollForCard(2, 0)).toBe(0)
    expect(scrollForCard(3, 182)).toBe(182)
  })

  it('brings in a card past the right edge as the third one shown', () => {
    expect(scrollForCard(3, 0)).toBe(182)
    expect(scrollForCard(7, 0)).toBe(910)
  })

  it('brings in a card past the left edge as the first one shown', () => {
    expect(scrollForCard(1, 364)).toBe(182)
    expect(scrollForCard(0, 910)).toBe(0)
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
