/**
 * Arrow-key navigation of the colour grid (3 rows x 7 columns). Left/Right step by one and wrap
 * around; Up/Down jump a row and stay put at the top/bottom edge; Home/End go to the ends.
 * Returns the index to move to, or null when the key does not navigate.
 */
export function nextSwatch(index: number, key: string, columns = 7, count = 21): number | null {
  if (count <= 0) return null
  const last = count - 1
  switch (key) {
    case 'ArrowRight':
      return index >= last ? 0 : index + 1
    case 'ArrowLeft':
      return index <= 0 ? last : index - 1
    case 'ArrowDown':
      return index + columns <= last ? index + columns : index
    case 'ArrowUp':
      return index - columns >= 0 ? index - columns : index
    case 'Home':
      return 0
    case 'End':
      return last
    default:
      return null
  }
}
