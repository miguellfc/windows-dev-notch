import { describe, expect, it } from 'vitest'
import { pushHistory } from '../../../src/renderer/notch/system/history'

describe('pushHistory', () => {
  it('appends the value to a copy of the buffer', () => {
    const buffer = [1, 2]
    const next = pushHistory(buffer, 3)
    expect(next).toEqual([1, 2, 3])
    expect(buffer).toEqual([1, 2])
    expect(next).not.toBe(buffer)
  })

  it('keeps only the last 60 values by default', () => {
    const full = Array.from({ length: 60 }, (_, index) => index)
    const next = pushHistory(full, 60)
    expect(next).toHaveLength(60)
    expect(next[0]).toBe(1)
    expect(next.at(-1)).toBe(60)
  })

  it('honours a custom maximum, also when the buffer is already longer', () => {
    expect(pushHistory([1, 2, 3, 4], 5, 3)).toEqual([3, 4, 5])
  })

  it('ignores a missing value', () => {
    const buffer = [1, 2]
    expect(pushHistory(buffer, null)).toEqual([1, 2])
    expect(pushHistory([], null)).toEqual([])
  })
})

describe('pushHistory with out-of-range values', () => {
  it('skips values that are not finite', () => {
    expect(pushHistory([1], Number.NaN)).toEqual([1])
    expect(pushHistory([1], Number.POSITIVE_INFINITY)).toEqual([1])
    expect(pushHistory([1], Number.NEGATIVE_INFINITY)).toEqual([1])
  })

  it('clamps to 0–100', () => {
    expect(pushHistory([], 120)).toEqual([100])
    expect(pushHistory([], -3)).toEqual([0])
  })
})
