import { describe, expect, it } from 'vitest'
import { clip, decodeSnippet, displaySender, senderAddress } from '../../../src/shared/gmail/headers'

describe('displaySender', () => {
  it('keeps the quoted name (without quotes), even with a comma', () => {
    expect(displaySender('"Doe, John" <j@x.com>')).toBe('Doe, John')
  })

  it('keeps a bare name before the address', () => {
    expect(displaySender('Ana <a@x>')).toBe('Ana')
  })

  it('falls back to the address when there is no name', () => {
    expect(displaySender('a@x')).toBe('a@x')
    expect(displaySender('<a@x>')).toBe('a@x')
    expect(displaySender('"" <a@x>')).toBe('a@x')
  })

  it('unescapes quotes inside a quoted name', () => {
    expect(displaySender('"The \\"Best\\" Shop" <s@x>')).toBe('The "Best" Shop')
  })

  it('gives an empty string for empty or missing headers', () => {
    expect(displaySender('')).toBe('')
    expect(displaySender('   ')).toBe('')
    expect(displaySender(undefined)).toBe('')
  })
})

describe('senderAddress', () => {
  it('takes the address between angle brackets', () => {
    expect(senderAddress('"Doe, John" <j@example.com>')).toBe('j@example.com')
    expect(senderAddress('<a@example.com>')).toBe('a@example.com')
  })

  it('takes the whole value when there are no brackets', () => {
    expect(senderAddress(' a@example.com ')).toBe('a@example.com')
  })

  it('gives an empty string for empty or missing headers', () => {
    expect(senderAddress('')).toBe('')
    expect(senderAddress(undefined)).toBe('')
  })
})

describe('decodeSnippet', () => {
  it('decodes the HTML entities Gmail puts in snippets, as plain text', () => {
    expect(decodeSnippet('It&#39;s &quot;ok&quot; &amp; &lt;b&gt; &#x41;')).toBe('It\'s "ok" & <b> A')
  })

  it('leaves unknown entities and plain text alone', () => {
    expect(decodeSnippet('a &nbsp; b &bogus; c')).toBe('a   b &bogus; c')
    expect(decodeSnippet('&#99999999;')).toBe('&#99999999;')
  })
})

describe('clip', () => {
  it('keeps short text and cuts long text to the bound', () => {
    expect(clip('hola', 10)).toBe('hola')
    expect(clip('abcdef', 3)).toBe('abc')
  })

  it('never splits a surrogate pair', () => {
    expect(clip('ab😀c', 3)).toBe('ab')
    expect(clip('ab😀c', 4)).toBe('ab😀')
  })
})
