import { describe, expect, it } from 'vitest'
import { CAPSULE_SIZES, COMPACT_WIDTHS, EXPANDED_HEIGHTS, expandedHeightFor, GMAIL_SIZES, gmailSizeFor, REVIEW_BLOCK_WIDTH, SHADOW_MARGIN, WINDOW_WIDTH, compactWidthFor, growsWindow, resizeOrder, windowBoundsFor, windowHeightFor } from '../../../src/shared/notch/geometry'

const workArea = { x: 0, y: 0, width: 1920, height: 1032 }

describe('windowBoundsFor', () => {
  it('centres the window horizontally at the top of the work area', () => {
    const bounds = windowBoundsFor('compact', workArea)
    expect(bounds.y).toBe(0)
    expect(bounds.x + bounds.width / 2).toBeCloseTo(960, 0)
  })

  it('leaves room for the shadow around the capsule', () => {
    const bounds = windowBoundsFor('expanded', workArea)
    expect(bounds.width).toBe(752)
    // The window fits the panel with Claude sessions; without them the capsule is shorter inside it.
    expect(bounds.height).toBe(6 + 308 + 72)
  })

  it('keeps one width for every mode: the widest capsule plus the shadow', () => {
    // Motion skips layout animations for 250 ms after innerWidth changes, so the width must not.
    expect(WINDOW_WIDTH).toBe(752)
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

describe('terminal panel geometry', () => {
  it('is 640x360 plus the shadow margin', () => {
    expect(CAPSULE_SIZES.terminal).toEqual({ width: 640, height: 360 })
    expect(windowBoundsFor('terminal', workArea).width).toBe(640 + SHADOW_MARGIN.side * 2)
    expect(windowBoundsFor('terminal', workArea).height).toBe(SHADOW_MARGIN.top + 360 + SHADOW_MARGIN.bottom)
  })

  it('grows the window before animating into the terminal and shrinks after leaving it', () => {
    expect(resizeOrder('expanded', 'terminal')).toBe('resize-first')
    expect(resizeOrder('terminal', 'expanded')).toBe('animate-first')
    expect(resizeOrder('terminal', 'compact')).toBe('animate-first')
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
    expect(resizeOrder('permission', 'expanded')).toBe('resize-first')
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

describe('system panel geometry', () => {
  it('is 520x280 (5 process rows) and keeps the window width set by the terminal', () => {
    expect(CAPSULE_SIZES.system).toEqual({ width: 520, height: 280 })
    expect(WINDOW_WIDTH).toBe(640 + SHADOW_MARGIN.side * 2)
    expect(windowBoundsFor('system', workArea).height).toBe(SHADOW_MARGIN.top + 280 + SHADOW_MARGIN.bottom)
  })

  it('orders the window against the other panels by height', () => {
    // 280 (system) < 300 (permission) < 308 (expanded window) < 320 (reminders) < 360 (terminal).
    expect(growsWindow('expanded', 'system')).toBe(false)
    expect(growsWindow('system', 'permission')).toBe(true)
    expect(growsWindow('system', 'reminders')).toBe(true)
    expect(growsWindow('system', 'terminal')).toBe(true)
    expect(growsWindow('permission', 'system')).toBe(false)
    expect(growsWindow('reminders', 'system')).toBe(false)
    expect(growsWindow('terminal', 'system')).toBe(false)
    expect(growsWindow('system', 'expanded')).toBe(true)
    expect(resizeOrder('system', 'expanded')).toBe('resize-first')
    expect(resizeOrder('expanded', 'system')).toBe('animate-first')
    expect(resizeOrder('system', 'reminders')).toBe('resize-first')
    expect(resizeOrder('reminders', 'system')).toBe('animate-first')
    expect(resizeOrder('terminal', 'system')).toBe('animate-first')
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
  it('fits time, the longest date and "100 %" three times in ES and EN (measured with Playwright)', () => {
    // Widest measured content + border: EN "12:59 PM · Wed, May 20 · 100% ×3" = 357.3 px.
    expect(CAPSULE_SIZES.compact).toEqual({ width: 358, height: 36 })
    expect(COMPACT_WIDTHS).toEqual({
      plain: 168,
      metrics: 299,
      metricsBattery: 358,
      metricsDisk: 376,
      metricsBatteryDisk: 435,
      // The mail block (Mail + "99+", 38.3 px measured in ES and EN) plus its gap, added to each.
      plainMail: 221,
      metricsMail: 348,
      metricsBatteryMail: 407,
      metricsDiskMail: 425,
      metricsBatteryDiskMail: 484,
    })
  })

  it('keeps time and date only, at the original width, when there is nothing to show', () => {
    expect(compactWidthFor(null)).toBe(168)
  })

  it('drops the battery slot on a machine without a battery', () => {
    expect(compactWidthFor({ battery: { percent: 82, charging: false }, disk: null })).toBe(358)
    expect(compactWidthFor({ battery: null, disk: null })).toBe(299)
  })

  it('adds the low-disk block after the battery, or after RAM without one', () => {
    expect(compactWidthFor({ battery: { percent: 82, charging: false }, disk: { letter: 'C', freePercent: 6 } })).toBe(COMPACT_WIDTHS.metricsBatteryDisk)
    expect(compactWidthFor({ battery: null, disk: { letter: 'C', freePercent: 6 } })).toBe(COMPACT_WIDTHS.metricsDisk)
    expect(COMPACT_WIDTHS.metricsDisk).toBeGreaterThan(COMPACT_WIDTHS.metrics)
    expect(COMPACT_WIDTHS.metricsBatteryDisk).toBeGreaterThan(COMPACT_WIDTHS.metricsBattery)
  })

  it('keeps the width when only an alert colour changes', () => {
    const base = { battery: { percent: 12, charging: false }, disk: null }
    const red = { ...base, alerts: { cpu: true, ram: true, battery: true } }
    expect(compactWidthFor(red)).toBe(compactWidthFor(base))
  })

  it('stays narrower than the panels, so the window width is unchanged', () => {
    expect(CAPSULE_SIZES.compact.width).toBeLessThan(CAPSULE_SIZES.terminal.width)
    // Widest compact content (EN, battery and low-disk block: 433.8 px) still fits the fixed window.
    expect(Math.max(...Object.values(COMPACT_WIDTHS)) + SHADOW_MARGIN.side * 2).toBeLessThanOrEqual(WINDOW_WIDTH)
    expect(WINDOW_WIDTH).toBe(640 + SHADOW_MARGIN.side * 2)
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
    expect(growsWindow('notes', 'terminal')).toBe(true)
    expect(growsWindow('terminal', 'notes')).toBe(false)
    expect(resizeOrder('expanded', 'notes')).toBe('resize-first')
    expect(resizeOrder('notes', 'expanded')).toBe('animate-first')
  })
})

describe('compact capsule width with the unread-mail block', () => {
  const battery = { percent: 82, charging: false }
  const disk = { letter: 'C', freePercent: 6 }

  it('adds the mail block after every other slot', () => {
    expect(compactWidthFor(null, true)).toBe(COMPACT_WIDTHS.plainMail)
    expect(compactWidthFor({ battery: null, disk: null }, true)).toBe(COMPACT_WIDTHS.metricsMail)
    expect(compactWidthFor({ battery, disk: null }, true)).toBe(COMPACT_WIDTHS.metricsBatteryMail)
    expect(compactWidthFor({ battery: null, disk }, true)).toBe(COMPACT_WIDTHS.metricsDiskMail)
    expect(compactWidthFor({ battery, disk }, true)).toBe(COMPACT_WIDTHS.metricsBatteryDiskMail)
  })

  it('takes no room without mail', () => {
    expect(compactWidthFor(null, false)).toBe(COMPACT_WIDTHS.plain)
    expect(compactWidthFor({ battery, disk }, false)).toBe(COMPACT_WIDTHS.metricsBatteryDisk)
    expect(compactWidthFor({ battery, disk })).toBe(COMPACT_WIDTHS.metricsBatteryDisk)
  })

  it('is wider than the same capsule without mail', () => {
    expect(COMPACT_WIDTHS.plainMail).toBeGreaterThan(COMPACT_WIDTHS.plain)
    expect(COMPACT_WIDTHS.metricsMail).toBeGreaterThan(COMPACT_WIDTHS.metrics)
    expect(COMPACT_WIDTHS.metricsBatteryMail).toBeGreaterThan(COMPACT_WIDTHS.metricsBattery)
    expect(COMPACT_WIDTHS.metricsDiskMail).toBeGreaterThan(COMPACT_WIDTHS.metricsDisk)
    expect(COMPACT_WIDTHS.metricsBatteryDiskMail).toBeGreaterThan(COMPACT_WIDTHS.metricsBatteryDisk)
  })

  it('still fits the fixed window in the worst case ("99+" with battery and disk)', () => {
    expect(COMPACT_WIDTHS.metricsBatteryDiskMail + SHADOW_MARGIN.side * 2).toBeLessThanOrEqual(WINDOW_WIDTH)
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
    expect(WINDOW_WIDTH).toBe(640 + SHADOW_MARGIN.side * 2)
  })

  it('grows the window from the integrations row and the alert, and shrinks back to them', () => {
    expect(resizeOrder('expanded', 'gmail')).toBe('resize-first')
    expect(resizeOrder('alert', 'gmail')).toBe('resize-first')
    expect(resizeOrder('gmail', 'expanded')).toBe('animate-first')
    expect(resizeOrder('gmail', 'compact')).toBe('animate-first')
    expect(growsWindow('terminal', 'gmail')).toBe(true)
  })
})

describe('expanded panel height', () => {
  it('is 236 without Claude sessions, 284 with one and 308 with two or more (sessions on their own line)', () => {
    expect(EXPANDED_HEIGHTS).toEqual({ plain: 236, oneSession: 284, sessions: 308 })
    expect(expandedHeightFor(0)).toBe(236)
    expect(expandedHeightFor(1)).toBe(284)
    expect(expandedHeightFor(2)).toBe(308)
    expect(expandedHeightFor(7)).toBe(308)
  })

  it('sizes the window for the taller panel, so sessions appearing never outgrow it', () => {
    expect(CAPSULE_SIZES.expanded).toEqual({ width: 440, height: EXPANDED_HEIGHTS.sessions })
  })
})

describe('question panel geometry', () => {
  it('is a 520 px wide panel (measured with Playwright) inside the constant window width', () => {
    expect(CAPSULE_SIZES.question.width).toBe(520)
    expect(CAPSULE_SIZES.question.height).toBe(504)
    expect(windowBoundsFor('question', workArea)).toMatchObject({ width: WINDOW_WIDTH, height: SHADOW_MARGIN.top + 504 + SHADOW_MARGIN.bottom })
  })

  it('is the tallest panel: it grows the window from every other mode and shrinks it back', () => {
    for (const mode of Object.keys(CAPSULE_SIZES) as (keyof typeof CAPSULE_SIZES)[]) {
      expect(CAPSULE_SIZES.question.height).toBeGreaterThanOrEqual(CAPSULE_SIZES[mode].height)
    }
    for (const from of ['alert', 'mini', 'expanded', 'permission', 'gmail', 'terminal'] as const) {
      expect(resizeOrder(from, 'question')).toBe('resize-first')
      expect(resizeOrder('question', from)).toBe('animate-first')
    }
  })
})

describe('compact capsule width with the code-review blocks', () => {
  const battery = { percent: 82, charging: false }
  const disk = { letter: 'C', freePercent: 6 }

  it('adds one measured block per platform after the other slots', () => {
    expect(compactWidthFor({ battery, disk }, true, 0)).toBe(COMPACT_WIDTHS.metricsBatteryDiskMail)
    expect(compactWidthFor({ battery, disk }, true, 1)).toBe(Math.ceil(COMPACT_WIDTHS.metricsBatteryDiskMail + REVIEW_BLOCK_WIDTH))
    expect(compactWidthFor({ battery, disk }, true, 2)).toBe(Math.ceil(COMPACT_WIDTHS.metricsBatteryDiskMail + 2 * REVIEW_BLOCK_WIDTH))
    expect(compactWidthFor({ battery: null, disk: null }, false, 1)).toBe(Math.ceil(COMPACT_WIDTHS.metrics + REVIEW_BLOCK_WIDTH))
  })

  it('after time and date alone takes the wider gaps, like the mail block', () => {
    expect(compactWidthFor(null, false, 1)).toBe(COMPACT_WIDTHS.plainMail)
    expect(compactWidthFor(null, false, 2)).toBe(Math.ceil(COMPACT_WIDTHS.plain + 4 + 2 * REVIEW_BLOCK_WIDTH))
    expect(compactWidthFor(null, true, 1)).toBe(Math.ceil(COMPACT_WIDTHS.plainMail + REVIEW_BLOCK_WIDTH))
  })

  it('still fits the fixed window in the worst case (two "99+" blocks with mail, battery and disk)', () => {
    expect(compactWidthFor({ battery, disk }, true, 2) + SHADOW_MARGIN.side * 2).toBeLessThanOrEqual(WINDOW_WIDTH)
  })
})

describe('reviews panel geometry', () => {
  it('is a panel no taller than the question card, so the window order stays as it was', () => {
    expect(CAPSULE_SIZES.reviews.height).toBeLessThanOrEqual(CAPSULE_SIZES.question.height)
    expect(CAPSULE_SIZES.reviews.width).toBeLessThanOrEqual(WINDOW_WIDTH - SHADOW_MARGIN.side * 2)
    expect(resizeOrder('compact', 'reviews')).toBe('resize-first')
    expect(resizeOrder('reviews', 'expanded')).toBe('animate-first')
  })
})
