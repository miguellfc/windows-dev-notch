import { describe, expect, it } from 'vitest'
import { onlineFrom } from '../../../src/renderer/shared/use-online'

describe('onlineFrom', () => {
  it('follows navigator.onLine', () => {
    expect(onlineFrom({ onLine: false })).toBe(false)
    expect(onlineFrom({ onLine: true })).toBe(true)
  })

  it('assumes online without a navigator', () => {
    expect(onlineFrom(undefined)).toBe(true)
  })
})
