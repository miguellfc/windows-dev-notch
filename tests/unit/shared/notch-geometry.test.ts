import { describe, expect, it } from 'vitest'
import { CAPSULE_SIZES, SHADOW_MARGIN, resizeOrder, windowBoundsFor } from '../../../src/shared/notch/geometry'

const workArea = { x: 0, y: 0, width: 1920, height: 1032 }

describe('windowBoundsFor', () => {
  it('centres the window horizontally at the top of the work area', () => {
    const bounds = windowBoundsFor('compact', workArea)
    expect(bounds.y).toBe(0)
    expect(bounds.x + bounds.width / 2).toBeCloseTo(960, 0)
  })

  it('leaves room for the shadow around the capsule', () => {
    const bounds = windowBoundsFor('expanded', workArea)
    expect(bounds.width).toBe(CAPSULE_SIZES.expanded.width + SHADOW_MARGIN.side * 2)
    expect(bounds.height).toBe(SHADOW_MARGIN.top + CAPSULE_SIZES.expanded.height + SHADOW_MARGIN.bottom)
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
  })

  it('grows the window before animating into the terminal and shrinks after leaving it', () => {
    expect(resizeOrder('expanded', 'terminal')).toBe('resize-first')
    expect(resizeOrder('terminal', 'expanded')).toBe('animate-first')
    expect(resizeOrder('terminal', 'compact')).toBe('animate-first')
  })
})
