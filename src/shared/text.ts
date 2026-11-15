/** Anything that is neither whitespace nor default-ignorable (ZWJ, variation selectors, Hangul fillers...). */
const VISIBLE_CHAR = /[^\s\p{Default_Ignorable_Code_Point}]/u

/** True when the text shows at least one character; a lone U+200D or only ZWJ and spaces does not. */
export const hasVisibleText = (text: string): boolean => VISIBLE_CHAR.test(text)
