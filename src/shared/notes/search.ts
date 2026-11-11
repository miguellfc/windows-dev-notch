import type { Note } from './schema'

/**
 * Lowercases and strips diacritics so "CANCIÓN" and "cancion" compare equal. Lowercasing comes
 * first: it can itself produce combining marks ("İ" becomes "i" + U+0307), which the strip removes.
 */
export const normalizeForSearch = (s: string): string =>
  s.toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '')

/** True when the normalized note text contains the normalized query; a blank query matches all. */
export const matchesQuery = (note: Note, query: string): boolean => {
  const q = normalizeForSearch(query).trim()
  return q === '' || normalizeForSearch(note.text).includes(q)
}

const time = (iso: string): number => new Date(iso).getTime()

/**
 * Pinned notes first, then most recently updated first within each group; equal updatedAt falls
 * back to the newest createdAt, then the id, so the order never depends on the input order.
 * Returns a new array.
 */
export const sortNotes = (notes: readonly Note[]): Note[] =>
  [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return (
      time(b.updatedAt) - time(a.updatedAt) ||
      time(b.createdAt) - time(a.createdAt) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    )
  })
