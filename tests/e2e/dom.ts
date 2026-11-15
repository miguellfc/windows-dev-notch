/**
 * The node tsconfig has no DOM lib (it type-checks the main process), so Playwright's `evaluate`
 * callbacks receive an element type without the DOM members. This is the minimal structural view of
 * the members the specs use. Cast inline (`el as PageElement`): callbacks are serialized into the
 * page, so they cannot call helpers, and there the real element has these members.
 */
export interface PageElement {
  scrollTo(x: number, y: number): void
  readonly scrollHeight: number
  readonly clientHeight: number
  getAttribute(name: string): string | null
  hasAttribute(name: string): boolean
}

