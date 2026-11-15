import { describe, expect, it } from 'vitest'
import { matchesQuery, normalizeForSearch, sortNotes } from '../../../src/shared/notes/search'
import type { Note } from '../../../src/shared/notes/schema'

const n = (k: number, over: Partial<Note> = {}): Note => ({
  id: `00000000-0000-4000-8000-${String(k).padStart(12, '0')}`,
  text: `note ${k}`,
  pinned: false,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: `2026-11-0${k}T00:00:00.000Z`,
  ...over,
})

describe('normalizeForSearch', () => {
  it('ignores case and diacritics', () => {
    expect(normalizeForSearch('CANCIÓN')).toBe(normalizeForSearch('cancion'))
    expect(normalizeForSearch('Ñandú')).toBe('nandu')
  })
  it('lowercases before stripping marks, so a precomposed capital loses its accent too', () => {
    // 'İ' lowercases to 'i' + U+0307 (combining dot above): the mark strip must still remove it.
    expect(normalizeForSearch('İstanbul')).toBe('istanbul')
    expect(normalizeForSearch('ÉLAN')).toBe('elan')
  })
})

describe('matchesQuery', () => {
  it('matches everything for an empty or blank query', () => {
    expect(matchesQuery(n(1), '')).toBe(true)
    expect(matchesQuery(n(1), '   ')).toBe(true)
  })
  it('matches substrings ignoring case and accents', () => {
    expect(matchesQuery(n(1, { text: 'Una Canción nueva' }), 'cancion')).toBe(true)
    expect(matchesQuery(n(1, { text: 'Una Canción nueva' }), 'CANCIÓN N')).toBe(true)
    expect(matchesQuery(n(1, { text: 'hola' }), 'adios')).toBe(false)
  })
})

describe('sortNotes', () => {
  it('puts pinned first, then updatedAt descending in both groups, without mutating', () => {
    const input = [n(1), n(3, { pinned: true }), n(2), n(4, { pinned: true })]
    const copy = [...input]
    expect(sortNotes(input).map((x) => x.text)).toEqual(['note 4', 'note 3', 'note 2', 'note 1'])
    expect(input).toEqual(copy)
  })
  it('breaks updatedAt ties by createdAt descending, then by id, for a stable order', () => {
    const same = '2026-11-05T00:00:00.000Z'
    const a = n(1, { updatedAt: same, createdAt: '2026-11-01T00:00:00.000Z', text: 'a' })
    const b = n(2, { updatedAt: same, createdAt: '2026-11-03T00:00:00.000Z', text: 'b' })
    const c = n(3, { updatedAt: same, createdAt: '2026-11-03T00:00:00.000Z', text: 'c' })
    const d = n(4, { updatedAt: same, createdAt: '2026-11-03T00:00:00.000Z', text: 'd' })
    const expected = ['b', 'c', 'd', 'a']
    expect(sortNotes([a, d, c, b]).map((x) => x.text)).toEqual(expected)
    expect(sortNotes([c, a, b, d]).map((x) => x.text)).toEqual(expected)
  })
})
