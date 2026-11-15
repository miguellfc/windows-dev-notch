import { describe, expect, it } from 'vitest'
import { parseTarget } from '../../../src/renderer/control-center/redmine-target'

describe('parseTarget', () => {
  it('accepts 1-24 h in steps of 0.5, with a comma or a dot', () => {
    expect(parseTarget('8')).toBe(8)
    expect(parseTarget(' 7,5 ')).toBe(7.5)
    expect(parseTarget('7.5')).toBe(7.5)
    expect(parseTarget('1')).toBe(1)
    expect(parseTarget('24')).toBe(24)
    expect(parseTarget('24,0')).toBe(24)
  })

  it('rejects values out of range or off the 0.5 step', () => {
    for (const raw of ['0', '0,5', '24,5', '25', '7,3', '7.25']) expect(parseTarget(raw), raw).toBeNull()
  })

  it('rejects anything that is not plain digits with one optional decimal', () => {
    for (const raw of ['', ' ', '0x10', '1e1', '+8', '-8', '8.', ',5', '8,5,5', '8 h', 'Infinity', '٨']) expect(parseTarget(raw), raw).toBeNull()
  })
})
