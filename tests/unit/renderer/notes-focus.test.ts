import { describe, expect, it } from 'vitest'
import { focusTarget } from '../../../src/renderer/shared/notes/focus'

describe('focusTarget', () => {
  it('follows the same note and button when rows were reordered (pin moves it)', () => {
    expect(focusTarget(['b', 'a', 'c'], { id: 'a', control: 'note-pin', index: 0 })).toEqual({ index: 1, control: 'note-pin' })
  })

  it('falls back to the next row at the same position, first action, when the note is gone', () => {
    expect(focusTarget(['a', 'c'], { id: 'b', control: 'note-delete', index: 1 })).toEqual({ index: 1, control: null })
  })

  it('falls back to the last row when the gone note was last', () => {
    expect(focusTarget(['a'], { id: 'b', control: 'note-delete', index: 1 })).toEqual({ index: 0, control: null })
  })

  it('returns null when no row is left', () => {
    expect(focusTarget([], { id: 'b', control: 'note-delete', index: 0 })).toBeNull()
  })
})
