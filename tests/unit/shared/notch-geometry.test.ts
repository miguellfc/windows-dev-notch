import { describe, expect, it } from 'vitest'
import { CAPSULE_SIZES, COMPACT_WIDTHS, SHADOW_MARGIN, WINDOW_WIDTH, compactWidthFor, growsWindow, resizeOrder, windowBoundsFor, windowHeightFor } from '../../../src/shared/notch/geometry'

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
    expect(bounds.height).toBe(6 + 236 + 72)
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
    expect(resizeOrder('permission', 'expanded')).toBe('animate-first')
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
    // 236 (expanded) < 280 (system) < 300 (permission) < 320 (reminders) < 360 (terminal).
    expect(growsWindow('expanded', 'system')).toBe(true)
    expect(growsWindow('system', 'permission')).toBe(true)
    expect(growsWindow('system', 'reminders')).toBe(true)
    expect(growsWindow('system', 'terminal')).toBe(true)
    expect(growsWindow('permission', 'system')).toBe(false)
    expect(growsWindow('reminders', 'system')).toBe(false)
    expect(growsWindow('terminal', 'system')).toBe(false)
    expect(growsWindow('system', 'expanded')).toBe(false)
    expect(resizeOrder('system', 'expanded')).toBe('animate-first')
    expect(resizeOrder('expanded', 'system')).toBe('resize-first')
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
    expect(COMPACT_WIDTHS).toEqual({ plain: 168, metrics: 299, metricsBattery: 358, metricsDisk: 376, metricsBatteryDisk: 435 })
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
