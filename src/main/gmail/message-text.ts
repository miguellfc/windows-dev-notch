import { convert, type DomNode, type FormatCallback, type HtmlToTextOptions } from 'html-to-text'
import {
  GMAIL_BODY_MAX,
  GMAIL_LINK_TEXT_MAX,
  GMAIL_LINKS_MAX,
  GMAIL_URL_MAX,
  type GmailLink,
  type MessagePayload,
} from '../../shared/gmail/schema'

/** MIME nesting deeper than this is not read (real mail stays within a handful of levels). */
const MIME_MAX_DEPTH = 50
/** At most this many MIME parts are visited. */
const MIME_MAX_PARTS = 500
/** HTML nesting deeper than this is replaced by an ellipsis instead of overflowing the stack. */
const HTML_MAX_DEPTH = 100

export interface ExtractedMessage {
  /** Plain text, at most {@link GMAIL_BODY_MAX} characters. */
  body: string
  truncated: boolean
  /** Unique `http`/`https` links in reading order, at most {@link GMAIL_LINKS_MAX}. */
  links: GmailLink[]
  /** Parts with a non-empty file name. */
  attachments: number
}

/**
 * A link worth offering: `http`/`https` only, normalised by `URL`, at most {@link GMAIL_URL_MAX}
 * characters; anything else gives `null`.
 */
function webUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!/^https?:/i.test(trimmed)) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.href.length <= GMAIL_URL_MAX ? url.href : null
  } catch {
    return null
  }
}

/** Collects unique links up to the cap; `add` gives the 1-based number of the link or `null`. */
function createLinkList() {
  const links: GmailLink[] = []
  const add = (url: string, text: string): number | null => {
    const known = links.findIndex((link) => link.url === url)
    if (known !== -1) return known + 1
    if (links.length >= GMAIL_LINKS_MAX) return null
    links.push({ text: (text || url).slice(0, GMAIL_LINK_TEXT_MAX), url })
    return links.length
  }
  return { links, add }
}

const charsetOf = (part: MessagePayload): string => {
  const contentType = part.headers.find((header) => header.name.toLowerCase() === 'content-type')?.value ?? ''
  return /charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1]?.toLowerCase() ?? 'utf-8'
}

/** UTF-8 and the Western single-byte sets; anything else is read as UTF-8 with replacement characters. */
function decoderLabel(charset: string): string {
  if (['iso-8859-1', 'iso8859-1', 'latin1', 'latin-1', 'l1', 'us-ascii', 'ascii'].includes(charset)) return 'latin1'
  if (['windows-1252', 'cp1252', 'x-cp1252'].includes(charset)) return 'windows-1252'
  return 'utf-8'
}

/** Gmail returns each part's content (transfer encoding already undone) as base64url bytes. */
function decodePart(part: MessagePayload): string {
  const data = part.body.data
  if (!data) return ''
  return new TextDecoder(decoderLabel(charsetOf(part))).decode(Buffer.from(data, 'base64url'))
}

const isAttachment = (part: MessagePayload): boolean => (part.filename ?? '').trim() !== ''

interface Found {
  plain?: MessagePayload
  html?: MessagePayload
  attachments: number
  visited: number
}

function walkParts(part: MessagePayload, found: Found, depth = 0): void {
  if (depth > MIME_MAX_DEPTH || found.visited >= MIME_MAX_PARTS) return
  found.visited += 1
  if (isAttachment(part)) {
    found.attachments += 1
  } else {
    const type = part.mimeType.toLowerCase()
    if (type === 'text/plain' && !found.plain && part.body.data) found.plain = part
    if (type === 'text/html' && !found.html && part.body.data) found.html = part
  }
  for (const child of part.parts ?? []) walkParts(child, found, depth + 1)
}

const HIDDEN_TAGS = new Set(['script', 'style', 'img', 'head', 'title'])

/**
 * Visible text of an anchor, iterative (no stack overflow on deep markup), without script,
 * style or image content, whitespace collapsed and capped at {@link GMAIL_LINK_TEXT_MAX}.
 */
function linkText(node: DomNode): string {
  let raw = ''
  const stack: DomNode[] = [...(node.children ?? [])].reverse()
  while (stack.length > 0 && raw.length < GMAIL_LINK_TEXT_MAX * 4) {
    const current = stack.pop()!
    if (current.type === 'text') raw += current.data ?? ''
    else if (!HIDDEN_TAGS.has((current.name ?? '').toLowerCase()) && current.type !== 'script' && current.type !== 'style')
      for (let i = (current.children ?? []).length - 1; i >= 0; i -= 1) stack.push(current.children[i]!)
  }
  return raw.replace(/\s+/g, ' ').trim().slice(0, GMAIL_LINK_TEXT_MAX)
}

function htmlToPlain(markup: string, addLink: (url: string, text: string) => number | null): string {
  const anchor: FormatCallback = (elem, walk, builder) => {
    const url = webUrl(elem.attribs?.href)
    const number = url ? addLink(url, linkText(elem)) : null
    walk(elem.children, builder)
    if (number !== null) builder.addInline(` [${number}]`)
  }
  const options: HtmlToTextOptions = {
    wordwrap: false,
    limits: { maxDepth: HTML_MAX_DEPTH, maxChildNodes: 10_000 },
    formatters: { gmailAnchor: anchor },
    selectors: [
      { selector: 'a', format: 'gmailAnchor' },
      { selector: 'img', format: 'skip' },
      { selector: 'script', format: 'skip' },
      { selector: 'style', format: 'skip' },
      // A bare document without <body> would otherwise print its <title>.
      { selector: 'head', format: 'skip' },
      { selector: 'title', format: 'skip' },
      // Mail headings read as written (not shouted) and spaced like paragraphs.
      ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((selector) => ({
        selector,
        options: { uppercase: false, leadingLineBreaks: 2, trailingLineBreaks: 2 },
      })),
      // Most mail tables are layout: one cell per line instead of a glued row.
      { selector: 'td', format: 'block', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
      { selector: 'th', format: 'block', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
    ],
  }
  return convert(markup, options)
}

/** Conservative: stops at spaces, quotes and brackets, then drops trailing punctuation. */
const TEXT_URL = /\bhttps?:\/\/[^\s<>"'()[\]{}]+/gi

function plainLinks(text: string, addLink: (url: string, text: string) => number | null): void {
  for (const match of text.matchAll(TEXT_URL)) {
    const url = webUrl(match[0].replace(/[.,;:!?]+$/, ''))
    if (url) addLink(url, url)
  }
}

function cut(text: string): { body: string; truncated: boolean } {
  if (text.length <= GMAIL_BODY_MAX) return { body: text, truncated: false }
  let end = GMAIL_BODY_MAX
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return { body: text.slice(0, end), truncated: true }
}

/**
 * Turns a `format=full` payload into what the notch shows: the `text/plain` part (or the
 * `text/html` part converted to text, never rendered), its `http`/`https` links and the number
 * of attachments. Pure: no I/O, nothing logged.
 */
export function extractMessage(payload: MessagePayload): ExtractedMessage {
  const found: Found = { attachments: 0, visited: 0 }
  walkParts(payload, found)
  const { links, add } = createLinkList()

  let text = ''
  if (found.plain) {
    text = decodePart(found.plain).replace(/\r\n?/g, '\n')
    plainLinks(text, add)
  } else if (found.html) {
    text = htmlToPlain(decodePart(found.html), add)
  }

  return { ...cut(text.trim()), links, attachments: found.attachments }
}
