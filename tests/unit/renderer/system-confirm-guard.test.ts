import { describe, expect, it } from 'vitest'
import { CONFIRM_ARM_MS, confirmArmed } from '../../../src/renderer/notch/system/confirm-guard'

describe('confirmArmed', () => {
  it('ignores Close for 300 ms after the question opens (a double click on ✕)', () => {
    expect(CONFIRM_ARM_MS).toBe(300)
    expect(confirmArmed(1000, 1000)).toBe(false)
    expect(confirmArmed(1000, 1299)).toBe(false)
  })

  it('accepts Close from 300 ms on', () => {
    expect(confirmArmed(1000, 1300)).toBe(true)
    expect(confirmArmed(1000, 5000)).toBe(true)
  })

  it('stays disarmed if the clock goes backwards', () => {
    expect(confirmArmed(1000, 900)).toBe(false)
  })
})
