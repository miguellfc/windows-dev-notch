/** Stands in for the used percentage in a translated disk line, so that figure alone can be rendered red. */
export const USED_MARK = '\u0001'

/** The text before and after the used-percentage mark; all of it is "before" when there is no mark. */
export function splitAtUsedMark(text: string): [before: string, after: string] {
  const at = text.indexOf(USED_MARK)
  return at === -1 ? [text, ''] : [text.slice(0, at), text.slice(at + USED_MARK.length)]
}
