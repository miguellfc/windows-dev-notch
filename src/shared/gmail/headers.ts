const unquote = (value: string): string =>
  value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).replace(/\\(.)/g, '$1').trim() : value

/**
 * Shortens a `From` header to what a person reads: the display name (without quotes) before
 * `<address>`, or the address when there is no name. Empty or missing → `''`.
 */
export function displaySender(from: string | undefined): string {
  const value = (from ?? '').trim()
  if (!value) return ''
  const match = /^(.*?)\s*<([^<>]*)>\s*$/.exec(value)
  if (!match) return unquote(value)
  const name = unquote((match[1] ?? '').trim())
  return name || (match[2] ?? '').trim()
}

/** The address of a `From` header: what sits between `<` and `>`, or the whole value without brackets. */
export function senderAddress(from: string | undefined): string {
  const value = (from ?? '').trim()
  const match = /<([^<>]*)>\s*$/.exec(value)
  return (match ? (match[1] ?? '') : value).trim()
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/**
 * Gmail returns snippets HTML-escaped (`It&#39;s`). Decodes the common entities into plain text;
 * the result is still rendered as text, never as HTML. Unknown entities stay as written.
 */
export function decodeSnippet(snippet: string): string {
  return snippet.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity
  })
}

/** Cuts text to at most `max` UTF-16 units without splitting a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const last = text.charCodeAt(max - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max)
}
