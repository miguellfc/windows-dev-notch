import { describe, expect, it } from 'vitest'
import { formatPercent } from '../../../src/renderer/notch/system/format'

// Intl separates the number and the unit with a no-break space (U+00A0).
const nb = ' '

describe('formatPercent', () => {
  it('rounds to a whole percent in each language', () => {
    expect(formatPercent(34.4, 'es')).toBe(`34${nb}%`)
    expect(formatPercent(34.6, 'en')).toBe('35%')
    expect(formatPercent(0, 'es')).toBe(`0${nb}%`)
    expect(formatPercent(100, 'en')).toBe('100%')
  })

  it('shows a dash when there is no value', () => {
    expect(formatPercent(null, 'es')).toBe('—')
    expect(formatPercent(null, 'en')).toBe('—')
  })
})
