import { describe, expect, it } from 'vitest'
import { durationText } from '../../../src/shared/work-log/duration'

const MIN = 60_000

describe('durationText', () => {
  it('formats zero as 0m', () => {
    expect(durationText(0)).toBe('0m')
  })

  it('truncates partial minutes', () => {
    expect(durationText(59_999)).toBe('0m')
  })

  it('formats whole minutes', () => {
    expect(durationText(MIN)).toBe('1m')
    expect(durationText(25 * MIN)).toBe('25m')
  })

  it('formats whole hours without minutes', () => {
    expect(durationText(60 * MIN)).toBe('1h')
  })

  it('formats hours and minutes', () => {
    expect(durationText(85 * MIN)).toBe('1h 25m')
    expect(durationText((5 * 60 + 45) * MIN)).toBe('5h 45m')
  })

  it('clamps negative durations to 0m', () => {
    expect(durationText(-5 * MIN)).toBe('0m')
  })
})
