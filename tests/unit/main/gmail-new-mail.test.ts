import { describe, expect, it } from 'vitest'
import { createNewMailDetector } from '../../../src/main/gmail/new-mail'

describe('createNewMailDetector', () => {
  it('only records the first observation as the reference', () => {
    const detector = createNewMailDetector()
    expect(detector.observe(['a', 'b'])).toEqual([])
    expect(detector.observe(['a', 'b'])).toEqual([])
  })

  it('treats an empty first observation as a reference too', () => {
    const detector = createNewMailDetector()
    expect(detector.observe([])).toEqual([])
    expect(detector.observe(['a'])).toEqual(['a'])
  })

  it('reports a new id', () => {
    const detector = createNewMailDetector()
    detector.observe(['a', 'b'])
    expect(detector.observe(['c', 'a', 'b'])).toEqual(['c'])
  })

  it('reports several new ids in list order (newest first)', () => {
    const detector = createNewMailDetector()
    detector.observe(['a'])
    expect(detector.observe(['e', 'd', 'a', 'c'])).toEqual(['e', 'd', 'c'])
  })

  it('does not count ids that disappear', () => {
    const detector = createNewMailDetector()
    detector.observe(['a', 'b', 'c'])
    expect(detector.observe(['b'])).toEqual([])
    expect(detector.observe([])).toEqual([])
  })

  it('counts an id that comes back after disappearing as new', () => {
    const detector = createNewMailDetector()
    detector.observe(['a', 'b'])
    expect(detector.observe(['b'])).toEqual([])
    expect(detector.observe(['a', 'b'])).toEqual(['a'])
  })

  it('reports a repeated id in one observation once', () => {
    const detector = createNewMailDetector()
    detector.observe([])
    expect(detector.observe(['a', 'a', 'b'])).toEqual(['a', 'b'])
  })

  it('makes the next observation a reference again after reset', () => {
    const detector = createNewMailDetector()
    detector.observe(['a'])
    detector.reset()
    expect(detector.observe(['x', 'y', 'a'])).toEqual([])
    expect(detector.observe(['z', 'x', 'y', 'a'])).toEqual(['z'])
  })

  it('does not keep a reference to the caller array', () => {
    const detector = createNewMailDetector()
    const ids = ['a']
    detector.observe(ids)
    ids.push('b')
    expect(detector.observe(['b', 'a'])).toEqual(['b'])
  })
})
