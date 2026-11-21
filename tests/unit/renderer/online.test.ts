import { describe, expect, it } from 'vitest'
import { connectionOnline, onlineFrom } from '../../../src/renderer/shared/use-online'

describe('onlineFrom', () => {
  it('follows navigator.onLine', () => {
    expect(onlineFrom({ onLine: false })).toBe(false)
    expect(onlineFrom({ onLine: true })).toBe(true)
  })

  it('assumes online without a navigator', () => {
    expect(onlineFrom(undefined)).toBe(true)
  })
})

describe('connectionOnline', () => {
  it("follows main's reading while navigator says online (a network without internet reads offline)", () => {
    expect(connectionOnline(false, true)).toBe(false)
    expect(connectionOnline(true, true)).toBe(true)
  })

  it('falls back to navigator.onLine without a reading', () => {
    expect(connectionOnline(null, true)).toBe(true)
    expect(connectionOnline(null, false)).toBe(false)
  })

  it('shows offline at once when navigator says so, even if the last sample said online', () => {
    expect(connectionOnline(true, false)).toBe(false)
    expect(connectionOnline(false, false)).toBe(false)
  })
})
