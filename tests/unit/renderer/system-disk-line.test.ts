import { describe, expect, it } from 'vitest'
import { USED_MARK, splitAtUsedMark } from '../../../src/renderer/notch/system/disk-line'

describe('disk line', () => {
  it('the mark is a control character no translation or figure contains', () => {
    expect(USED_MARK).toBe('\u0001')
  })

  it('splits the line around the used figure', () => {
    expect(splitAtUsedMark(`C: ${USED_MARK} · 12 GB libres · actividad 3 %`)).toEqual(['C: ', ' · 12 GB libres · actividad 3 %'])
  })

  it('puts everything before the mark when there is none', () => {
    expect(splitAtUsedMark('C: 94 %')).toEqual(['C: 94 %', ''])
  })

  it('handles the mark at either end', () => {
    expect(splitAtUsedMark(`${USED_MARK} free`)).toEqual(['', ' free'])
    expect(splitAtUsedMark(`C: ${USED_MARK}`)).toEqual(['C: ', ''])
  })
})
