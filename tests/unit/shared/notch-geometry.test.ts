import { describe, expect, it } from 'vitest'
import { CAPSULE_BLOCK, CAPSULE_SIZES, capsuleTopFor, COMPACT_ZONE, GMAIL_SIZES, gmailSizeFor, REDMINE_SIZES, redmineSizeFor, reviewsSizeFor, SHADOW_MARGIN, WIDEST_COMPACT_WIDTH, WINDOW_WIDTH, compactWidthFor, growsWindow, resizeOrder, windowBoundsFor, windowHeightFor, type CompactContent } from '../../../src/shared/notch/geometry'

const workArea = { x: 0, y: 0, width: 1920, height: 1032 }

describe('windowBoundsFor', () => {
  it('centres the window horizontally at the top of the work area', () => {
    const bounds = windowBoundsFor('compact', workArea)
    expect(bounds.y).toBe(0)
    expect(bounds.x + bounds.width / 2).toBeCloseTo(960, 0)
  })

  it('leaves room for the shadow around the capsule', () => {
    const bounds = windowBoundsFor('expanded', workArea)
    expect(bounds.width).toBe(854)
    // The panel has one size: 6 + 300 + 72.
    expect(bounds.height).toBe(378)
  })

  it('keeps one width for every mode: the widest capsule plus the shadow', () => {
    // Motion skips layout animations for 250 ms after innerWidth changes, so the width must not.
    expect(WINDOW_WIDTH).toBe(854)
    for (const mode of Object.keys(CAPSULE_SIZES) as (keyof typeof CAPSULE_SIZES)[]) {
      const bounds = windowBoundsFor(mode, workArea)
      expect(bounds.width).toBe(WINDOW_WIDTH)
      expect(bounds.x).toBe(windowBoundsFor('compact', workArea).x)
    }
  })

  it('does not clip the levitation shadow (0 18px 50px)', () => {
    expect(SHADOW_MARGIN.side).toBeGreaterThanOrEqual(50)
    expect(SHADOW_MARGIN.bottom).toBeGreaterThanOrEqual(18 + 50)
  })

  it('follows a secondary monitor and a top taskbar', () => {
    const bounds = windowBoundsFor('compact', { x: 1920, y: 40, width: 2560, height: 1400 })
    expect(bounds.y).toBe(40)
    expect(bounds.x + bounds.width / 2).toBeCloseTo(1920 + 1280, 0)
  })

  it('returns integer pixel values', () => {
    const bounds = windowBoundsFor('peek', { x: 0, y: 0, width: 1365, height: 767 })
    for (const value of Object.values(bounds)) expect(Number.isInteger(value)).toBe(true)
  })
})

describe('resizeOrder', () => {
  it('resizes the window first when growing and animates first when shrinking', () => {
    expect(resizeOrder('compact', 'expanded')).toBe('resize-first')
    expect(resizeOrder('expanded', 'compact')).toBe('animate-first')
    expect(resizeOrder('compact', 'mini')).toBe('animate-first')
    expect(resizeOrder('mini', 'peek')).toBe('resize-first')
  })
})

describe('alert and permission geometry', () => {
  it('has the alert capsule and the permission card sizes', () => {
    expect(CAPSULE_SIZES.alert).toEqual({ width: 320, height: 44 })
    expect(CAPSULE_SIZES.permission).toEqual({ width: 480, height: 300 })
  })

  it('orders resizes by window height', () => {
    expect(resizeOrder('compact', 'alert')).toBe('resize-first')
    expect(resizeOrder('alert', 'permission')).toBe('resize-first')
    expect(resizeOrder('permission', 'alert')).toBe('animate-first')
    // The panel and the permission card are equally tall: an equal height counts as growing.
    expect(windowHeightFor('permission')).toBe(windowHeightFor('expanded'))
    expect(resizeOrder('permission', 'expanded')).toBe('resize-first')
    expect(resizeOrder('expanded', 'permission')).toBe('resize-first')
  })

  it('orders reminders (420×320) and permission (480×300) by height, not area', () => {
    // Permission has the larger area but the shorter window: growing into reminders must
    // enlarge the window first, and moving to permission must animate before it shrinks.
    expect(windowHeightFor('reminders')).toBeGreaterThan(windowHeightFor('permission'))
    expect(resizeOrder('permission', 'reminders')).toBe('resize-first')
    expect(resizeOrder('reminders', 'permission')).toBe('animate-first')
    expect(growsWindow('permission', 'reminders')).toBe(true)
    expect(growsWindow('reminders', 'permission')).toBe(false)
  })
})

describe('window width', () => {
  it('is set by the widest compact capsule', () => {
    expect(WINDOW_WIDTH).toBe(854)
  })
})

describe('reminders panel geometry', () => {
  it('is 420x320 plus the shadow margin in height', () => {
    expect(CAPSULE_SIZES.reminders).toEqual({ width: 420, height: 320 })
    expect(windowBoundsFor('reminders', workArea).height).toBe(SHADOW_MARGIN.top + 320 + SHADOW_MARGIN.bottom)
  })

  it('grows the window before animating into the panel and shrinks after leaving it', () => {
    expect(resizeOrder('expanded', 'reminders')).toBe('resize-first')
    expect(resizeOrder('alert', 'reminders')).toBe('resize-first')
    expect(resizeOrder('reminders', 'alert')).toBe('animate-first')
  })
})

describe('compact capsule width', () => {
  const NO_BLOCKS: CompactContent['blocks'] = { claude: false, mail: false, reviews: 0, redmine: false }
  const ALL_BLOCKS: CompactContent['blocks'] = { claude: true, mail: true, reviews: 2, redmine: true }
  const { padding, divider, left, system, battery } = COMPACT_ZONE

  it('pins the zones and blocks measured in WebView2 (worst of ES and EN)', () => {
    expect(COMPACT_ZONE).toEqual({ padding: 30, divider: 15, left: 143.5, system: 212.5, battery: 63.5 })
    expect(CAPSULE_BLOCK).toEqual({ claude: 22, mail: 48.5, review: 56, redmine: 78.5 })
  })

  it('is time and date alone without blocks or system: the peek width', () => {
    expect(compactWidthFor({ system: null, blocks: NO_BLOCKS })).toBe(Math.ceil(padding + left))
    expect(compactWidthFor({ system: null, blocks: NO_BLOCKS })).toBe(CAPSULE_SIZES.peek.width)
  })

  it('adds the divider and the system zone with a sample, and the battery when there is one', () => {
    expect(compactWidthFor({ system: { battery: false }, blocks: NO_BLOCKS })).toBe(Math.ceil(padding + left + divider + system))
    expect(compactWidthFor({ system: { battery: true }, blocks: NO_BLOCKS })).toBe(Math.ceil(padding + left + divider + system + battery))
    expect(compactWidthFor({ system: { battery: true }, blocks: NO_BLOCKS })).toBe(CAPSULE_SIZES.compact.width)
  })

  it('adds each block its width, and the middle divider once while there is a block', () => {
    const base = padding + left
    expect(compactWidthFor({ system: null, blocks: { ...NO_BLOCKS, claude: true } })).toBe(Math.ceil(base + divider + CAPSULE_BLOCK.claude))
    expect(compactWidthFor({ system: null, blocks: { ...NO_BLOCKS, mail: true } })).toBe(Math.ceil(base + divider + CAPSULE_BLOCK.mail))
    expect(compactWidthFor({ system: null, blocks: { ...NO_BLOCKS, reviews: 1 } })).toBe(Math.ceil(base + divider + CAPSULE_BLOCK.review))
    expect(compactWidthFor({ system: null, blocks: { ...NO_BLOCKS, reviews: 2 } })).toBe(Math.ceil(base + divider + 2 * CAPSULE_BLOCK.review))
    expect(compactWidthFor({ system: null, blocks: { ...NO_BLOCKS, redmine: true } })).toBe(Math.ceil(base + divider + CAPSULE_BLOCK.redmine))
    const blocks = CAPSULE_BLOCK.claude + CAPSULE_BLOCK.mail + 2 * CAPSULE_BLOCK.review + CAPSULE_BLOCK.redmine
    expect(compactWidthFor({ system: { battery: false }, blocks: ALL_BLOCKS })).toBe(Math.ceil(base + divider + blocks + divider + system))
  })

  it('drops the middle divider with the last block: hiding every block narrows it by exactly what they measured', () => {
    const withMail = compactWidthFor({ system: { battery: true }, blocks: { ...NO_BLOCKS, mail: true } })
    const without = compactWidthFor({ system: { battery: true }, blocks: NO_BLOCKS })
    expect(without).toBe(Math.ceil(padding + left + divider + system + battery))
    expect(withMail).toBe(Math.ceil(padding + left + divider + CAPSULE_BLOCK.mail + divider + system + battery))
    expect(Math.abs(withMail - without - (divider + CAPSULE_BLOCK.mail))).toBeLessThan(1)
  })

  it('never depends on an alert (a low disk only paints the storage figure red): alerts are not an input', () => {
    // The content type has no alert or disk field: the width is the same whatever is red.
    const content = { system: { battery: true }, blocks: ALL_BLOCKS, alerts: { disk: true } }
    expect(compactWidthFor(content)).toBe(compactWidthFor({ system: { battery: true }, blocks: ALL_BLOCKS }))
  })

  it('fits the worst case (every block, two reviews, system and battery) in the window with its shadow', () => {
    expect(WIDEST_COMPACT_WIDTH).toBe(compactWidthFor({ system: { battery: true }, blocks: ALL_BLOCKS }))
    expect(WIDEST_COMPACT_WIDTH).toBe(741)
    expect(WIDEST_COMPACT_WIDTH + SHADOW_MARGIN.side * 2).toBeLessThanOrEqual(WINDOW_WIDTH)
  })

  it('sets the window width by the formula: ceil((max(worst compact, panels) + 112) / 2) * 2', () => {
    const widest = Math.max(WIDEST_COMPACT_WIDTH, ...Object.values(CAPSULE_SIZES).map((size) => size.width))
    expect(WINDOW_WIDTH).toBe(Math.ceil((widest + SHADOW_MARGIN.side * 2) / 2) * 2)
    expect(WINDOW_WIDTH).toBe(854)
  })
})

describe('notes panel geometry', () => {
  it('is 420×320 and its window is as tall as reminders', () => {
    expect(CAPSULE_SIZES.notes).toEqual({ width: 420, height: 320 })
    expect(windowBoundsFor('notes', workArea).height).toBe(SHADOW_MARGIN.top + 320 + SHADOW_MARGIN.bottom)
  })

  it('orders the window changes by height', () => {
    expect(growsWindow('expanded', 'notes')).toBe(true)
    expect(growsWindow('notes', 'expanded')).toBe(false)
    expect(growsWindow('permission', 'notes')).toBe(true)
    expect(growsWindow('notes', 'permission')).toBe(false)
    expect(growsWindow('notes', 'reviews')).toBe(true)
    expect(growsWindow('reviews', 'notes')).toBe(false)
    expect(resizeOrder('expanded', 'notes')).toBe('resize-first')
    expect(resizeOrder('notes', 'expanded')).toBe('animate-first')
  })
})

describe('gmail panel geometry', () => {
  it('lists in 420×382 (5 rows of 58 px, measured with Playwright: no gap, no scroll)', () => {
    expect(GMAIL_SIZES.list).toEqual({ width: 420, height: 382 })
    expect(gmailSizeFor(false)).toEqual(GMAIL_SIZES.list)
  })

  it('reads in 520×440 (measured with Playwright: header and footer never clip, the body scrolls)', () => {
    expect(GMAIL_SIZES.reader).toEqual({ width: 520, height: 440 })
    expect(gmailSizeFor(true)).toEqual(GMAIL_SIZES.reader)
  })

  it('sizes the window for the reader, so opening a message never outgrows it, and keeps the window width', () => {
    expect(CAPSULE_SIZES.gmail).toEqual(GMAIL_SIZES.reader)
    expect(GMAIL_SIZES.reader.height).toBeGreaterThanOrEqual(GMAIL_SIZES.list.height)
    expect(windowBoundsFor('gmail', workArea).height).toBe(SHADOW_MARGIN.top + GMAIL_SIZES.reader.height + SHADOW_MARGIN.bottom)
    expect(WINDOW_WIDTH).toBe(854)
  })

  it('grows the window from the integrations row and the alert, and shrinks back to them', () => {
    expect(resizeOrder('expanded', 'gmail')).toBe('resize-first')
    expect(resizeOrder('alert', 'gmail')).toBe('resize-first')
    expect(resizeOrder('gmail', 'expanded')).toBe('animate-first')
    expect(resizeOrder('gmail', 'compact')).toBe('animate-first')
    expect(growsWindow('reminders', 'gmail')).toBe(true)
  })
})

describe('expanded panel size', () => {
  it('is one size, 712×300: 3.5 cards wide, whatever the panel lists', () => {
    expect(CAPSULE_SIZES.expanded).toEqual({ width: 712, height: 300 })
    // 12 + 44 + 10 + (3.5 × 172 + 3 × 10) + 12 + 2 of border.
    expect(12 + 44 + 10 + (3.5 * 172 + 3 * 10) + 12 + 2).toBe(CAPSULE_SIZES.expanded.width)
    // 14 + 28 + 10 + 196 + 8 + 4 + 8 + 20 + 10 + 2 of border.
    expect(14 + 28 + 10 + 196 + 8 + 4 + 8 + 20 + 10 + 2).toBe(CAPSULE_SIZES.expanded.height)
  })

  it('has a 378 px window and leaves the window width at 854', () => {
    expect(windowHeightFor('expanded')).toBe(378)
    expect(WINDOW_WIDTH).toBe(854)
  })
})

describe('question panel geometry', () => {
  it('is a 520 px wide panel (measured with Playwright) inside the constant window width', () => {
    expect(CAPSULE_SIZES.question.width).toBe(520)
    expect(CAPSULE_SIZES.question.height).toBe(504)
    expect(windowBoundsFor('question', workArea)).toMatchObject({ width: WINDOW_WIDTH, height: SHADOW_MARGIN.top + 504 + SHADOW_MARGIN.bottom })
  })

  it('is taller than every panel but Redmine: it grows the window from them and shrinks it back', () => {
    for (const mode of Object.keys(CAPSULE_SIZES) as (keyof typeof CAPSULE_SIZES)[]) {
      if (mode === 'redmine' || mode === 'workLog') continue
      expect(CAPSULE_SIZES.question.height).toBeGreaterThanOrEqual(CAPSULE_SIZES[mode].height)
    }
    for (const from of ['alert', 'mini', 'expanded', 'permission', 'gmail', 'reminders', 'reviews'] as const) {
      expect(resizeOrder(from, 'question')).toBe('resize-first')
      expect(resizeOrder('question', from)).toBe('animate-first')
    }
  })
})

/** Measured in WebView2 with the worst case (see REVIEWS_SIZE). */
const REVIEWS_HEIGHT = 324

describe('reviews panel geometry', () => {
  it('is the 520 px wide panel measured in WebView2 (contributions and the profile row), inside the window width', () => {
    expect(CAPSULE_SIZES.reviews).toEqual({ width: 520, height: REVIEWS_HEIGHT })
    expect(CAPSULE_SIZES.reviews.width).toBeLessThanOrEqual(WINDOW_WIDTH - SHADOW_MARGIN.side * 2)
    expect(windowBoundsFor('reviews', workArea)).toMatchObject({ width: WINDOW_WIDTH, height: SHADOW_MARGIN.top + REVIEWS_HEIGHT + SHADOW_MARGIN.bottom })
  })

  it('fits the capsule to the view while it shows contributions, never past the panel', () => {
    expect(reviewsSizeFor(null)).toEqual(CAPSULE_SIZES.reviews)
    expect(reviewsSizeFor(240)).toEqual({ width: 520, height: 242 })
    expect(reviewsSizeFor(400)).toEqual(CAPSULE_SIZES.reviews)
  })

  it('is shorter than the Redmine view, which is now the tallest panel', () => {
    for (const mode of Object.keys(CAPSULE_SIZES) as (keyof typeof CAPSULE_SIZES)[]) {
      expect(CAPSULE_SIZES.redmine.height).toBeGreaterThanOrEqual(CAPSULE_SIZES[mode].height)
    }
    expect(CAPSULE_SIZES.reviews.height).toBeLessThan(CAPSULE_SIZES.redmine.height)
  })

  it('keeps the window width: the widest panel is 712 px, so the compact capsule 741 px worst case (every block) sets it', () => {
    expect(Math.max(...Object.values(CAPSULE_SIZES).map((size) => size.width))).toBe(712)
    expect(WINDOW_WIDTH).toBe(854)
  })
})

describe('Redmine panel geometry', () => {
  it('rests shorter than it searches, at the same width', () => {
    expect(REDMINE_SIZES.search).toEqual({ width: 520, height: 560 })
    // Measured in WebView2 with the hours error line and the offline footer.
    expect(REDMINE_SIZES.rest).toEqual({ width: 520, height: 272 })
    expect(redmineSizeFor(false)).toEqual(REDMINE_SIZES.rest)
    expect(redmineSizeFor(true)).toEqual(REDMINE_SIZES.search)
    // The capsule fits the view, never past the rest size at rest nor the search size while searching.
    expect(redmineSizeFor(false, 200)).toEqual({ width: 520, height: 202 })
    expect(redmineSizeFor(false, 400)).toEqual(REDMINE_SIZES.rest)
    expect(redmineSizeFor(true, 400)).toEqual({ width: 520, height: 402 })
    expect(redmineSizeFor(true, 700)).toEqual(REDMINE_SIZES.search)
  })

  it('sizes the window for the search, so searching never resizes it', () => {
    expect(CAPSULE_SIZES.redmine).toEqual(REDMINE_SIZES.search)
    expect(windowBoundsFor('redmine', workArea)).toMatchObject({ width: WINDOW_WIDTH, height: SHADOW_MARGIN.top + 560 + SHADOW_MARGIN.bottom })
    expect(resizeOrder('expanded', 'redmine')).toBe('resize-first')
    expect(resizeOrder('redmine', 'expanded')).toBe('animate-first')
  })
})

describe('capsule modes geometry (peek at rest, compact on hover, pinned mini)', () => {
  it('peek is the time-and-date capsule: as tall as compact, so hovering never resizes the window', () => {
    expect(CAPSULE_SIZES.peek).toEqual({ width: Math.ceil(COMPACT_ZONE.padding + COMPACT_ZONE.left), height: CAPSULE_SIZES.compact.height })
    expect(CAPSULE_SIZES.peek.width).toBe(174)
    expect(windowHeightFor('peek')).toBe(windowHeightFor('compact'))
  })

  it('the pinned mini is a thin pill flush against the top edge (no shadow room above it)', () => {
    expect(CAPSULE_SIZES.mini.height).toBeLessThan(6)
    expect(CAPSULE_SIZES.mini.height).toBeGreaterThanOrEqual(3)
    expect(CAPSULE_SIZES.mini.width).toBeGreaterThanOrEqual(24)
    expect(capsuleTopFor('mini')).toBe(0)
    expect(windowHeightFor('mini')).toBe(CAPSULE_SIZES.mini.height + SHADOW_MARGIN.bottom)
    expect(windowBoundsFor('mini', workArea).y).toBe(workArea.y)
  })

  it('every other capsule keeps its shadow room above it', () => {
    for (const mode of Object.keys(CAPSULE_SIZES) as (keyof typeof CAPSULE_SIZES)[]) {
      if (mode !== 'mini') expect(capsuleTopFor(mode)).toBe(SHADOW_MARGIN.top)
    }
  })

  it('peek ↔ compact and compact → mini order the window like any other change', () => {
    expect(resizeOrder('peek', 'compact')).toBe('resize-first')
    expect(resizeOrder('compact', 'mini')).toBe('animate-first')
    expect(resizeOrder('mini', 'compact')).toBe('resize-first')
  })
})
