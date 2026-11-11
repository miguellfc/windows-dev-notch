import { describe, expect, it } from 'vitest'
import { radioKeyTarget, radioTabStop } from '../../../src/renderer/ui/roving'

describe('radioKeyTarget', () => {
  it('moves forward with Right and Down, wrapping at the end', () => {
    expect(radioKeyTarget('ArrowRight', 0, 3)).toBe(1)
    expect(radioKeyTarget('ArrowDown', 1, 3)).toBe(2)
    expect(radioKeyTarget('ArrowRight', 2, 3)).toBe(0)
  })

  it('moves back with Left and Up, wrapping at the start', () => {
    expect(radioKeyTarget('ArrowLeft', 2, 3)).toBe(1)
    expect(radioKeyTarget('ArrowUp', 0, 3)).toBe(2)
  })

  it('jumps to the ends with Home and End', () => {
    expect(radioKeyTarget('Home', 2, 3)).toBe(0)
    expect(radioKeyTarget('End', 0, 3)).toBe(2)
  })

  it('ignores other keys and empty groups', () => {
    expect(radioKeyTarget('Tab', 0, 3)).toBeNull()
    expect(radioKeyTarget('Enter', 0, 3)).toBeNull()
    expect(radioKeyTarget('ArrowRight', 0, 0)).toBeNull()
  })

  it('clamps an out-of-range start', () => {
    expect(radioKeyTarget('ArrowRight', -1, 3)).toBe(1)
    expect(radioKeyTarget('ArrowLeft', 9, 3)).toBe(1)
  })
})

describe('radioTabStop', () => {
  it('is the checked option, or the first when none is checked', () => {
    expect(radioTabStop(2)).toBe(2)
    expect(radioTabStop(-1)).toBe(0)
  })
})
