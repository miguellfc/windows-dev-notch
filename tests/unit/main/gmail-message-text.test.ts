import { describe, expect, it } from 'vitest'
import { extractMessage } from '../../../src/main/gmail/message-text'
import { GMAIL_BODY_MAX, GMAIL_LINKS_MAX, GMAIL_URL_MAX, messageFullSchema, type MessagePayload } from '../../../src/shared/gmail/schema'

const encode = (bytes: Buffer): string => bytes.toString('base64url')
const utf8 = (text: string): string => encode(Buffer.from(text, 'utf8'))

const part = (mimeType: string, data: string | undefined, options: { charset?: string; filename?: string } = {}): MessagePayload => ({
  mimeType,
  filename: options.filename ?? '',
  headers: [{ name: 'Content-Type', value: options.charset ? `${mimeType}; charset="${options.charset}"` : mimeType }],
  body: data === undefined ? { size: 0 } : { data, size: Buffer.from(data, 'base64url').length },
})

const multipart = (mimeType: string, parts: MessagePayload[]): MessagePayload => ({
  mimeType,
  filename: '',
  headers: [{ name: 'Content-Type', value: `${mimeType}; boundary="b"` }],
  body: { size: 0 },
  parts,
})

const html = (markup: string): MessagePayload => part('text/html', utf8(markup), { charset: 'UTF-8' })
const plain = (text: string): MessagePayload => part('text/plain', utf8(text), { charset: 'utf-8' })

describe('extractMessage body', () => {
  it('reads a text/plain message', () => {
    expect(extractMessage(plain('Hola Ana,\r\n\r\nNos vemos mañana.\r\n'))).toEqual({
      body: 'Hola Ana,\n\nNos vemos mañana.',
      truncated: false,
      links: [],
      attachments: 0,
    })
  })

  it('converts a text/html message with paragraphs, breaks and lists as line breaks', () => {
    const { body } = extractMessage(html('<p>Uno</p><p>Dos<br>Tres</p><ul><li>alfa</li><li>beta</li></ul>'))
    expect(body).toMatch(/^Uno\n+Dos\nTres\n+/)
    expect(body.split('\n')).toEqual(['Uno', '', 'Dos', 'Tres', '', ' * alfa', ' * beta'])
  })

  it('keeps headings as written and puts table cells on their own lines', () => {
    const { body } = extractMessage(
      html('<h1>Título</h1><h3>Sub</h3><table><tr><th>Mes</th><th>Total</th></tr><tr><td>enero</td><td>3</td></tr></table>'),
    )
    expect(body.split('\n')).toEqual(['Título', '', 'Sub', '', 'Mes', 'Total', 'enero', '3'])
  })

  it('prefers text/plain in multipart/alternative', () => {
    const payload = multipart('multipart/alternative', [plain('Texto plano'), html('<p>Versión <b>HTML</b></p>')])
    expect(extractMessage(payload).body).toBe('Texto plano')
    const htmlFirst = multipart('multipart/alternative', [html('<p>Versión HTML</p>'), plain('Texto plano')])
    expect(extractMessage(htmlFirst).body).toBe('Texto plano')
  })

  it('finds the text in a nested multipart/mixed and counts the attachment', () => {
    const payload = multipart('multipart/mixed', [
      multipart('multipart/alternative', [plain('Adjunto el informe.'), html('<p>Adjunto el informe.</p>')]),
      { ...part('application/pdf', undefined, { filename: 'informe.pdf' }), body: { size: 2048 } },
    ])
    expect(extractMessage(payload)).toEqual({ body: 'Adjunto el informe.', truncated: false, links: [], attachments: 1 })
  })

  it('never takes a text attachment as the body', () => {
    const payload = multipart('multipart/mixed', [html('<p>Cuerpo</p>'), part('text/plain', utf8('notas'), { filename: 'notas.txt' })])
    expect(extractMessage(payload)).toMatchObject({ body: 'Cuerpo', attachments: 1 })
  })

  it('decodes base64url with - and _ and without padding', () => {
    const text = 'a>>>b???¿ok?'
    const data = utf8(text)
    expect(data).toMatch(/[-_]/)
    expect(data).not.toMatch(/=/)
    expect(extractMessage(plain(text)).body).toBe(text)
  })

  it('decodes iso-8859-1 and windows-1252 parts', () => {
    const latin1 = part('text/plain', encode(Buffer.from([0x61, 0xf1, 0x6f])), { charset: 'iso-8859-1' })
    expect(extractMessage(latin1).body).toBe('año')
    const cp1252 = part('text/plain', encode(Buffer.from([0x31, 0x30, 0x20, 0x80, 0x20, 0xf1])), { charset: 'windows-1252' })
    expect(extractMessage(cp1252).body).toBe('10 € ñ')
    const html1252 = part('text/html', encode(Buffer.from([0x3c, 0x70, 0x3e, 0x80, 0xf1, 0x3c, 0x2f, 0x70, 0x3e])), { charset: 'Windows-1252' })
    expect(extractMessage(html1252).body).toBe('€ñ')
  })

  it('reads unknown charsets as utf-8 with replacement characters', () => {
    expect(extractMessage(part('text/plain', utf8('mañana'), { charset: 'x-unknown' })).body).toBe('mañana')
    expect(extractMessage(part('text/plain', encode(Buffer.from([0x61, 0xff, 0x62])), { charset: 'x-unknown' })).body).toBe('a�b')
    expect(extractMessage(part('text/plain', utf8('sin charset'))).body).toBe('sin charset')
  })

  it('drops script, style and images', () => {
    const { body } = extractMessage(
      html(
        '<style>.a{color:red}</style><script>alert("x")</script><p>Hola</p><img src="https://example.com/t.png" alt="pixel"><noscript></noscript>',
      ),
    )
    expect(body).toBe('Hola')
  })

  it('cuts a long body to 50 000 characters', () => {
    const result = extractMessage(plain('x'.repeat(60_000)))
    expect(result.body).toHaveLength(GMAIL_BODY_MAX)
    expect(result.truncated).toBe(true)
    expect(extractMessage(plain('x'.repeat(GMAIL_BODY_MAX))).truncated).toBe(false)
  })

  it('does not split a surrogate pair when cutting', () => {
    const result = extractMessage(plain('x'.repeat(GMAIL_BODY_MAX - 1) + '😀'.repeat(10)))
    expect(result.truncated).toBe(true)
    expect(result.body).toBe('x'.repeat(GMAIL_BODY_MAX - 1))
  })

  it('gives an empty body when there is no text part', () => {
    expect(extractMessage(part('text/plain', undefined))).toEqual({ body: '', truncated: false, links: [], attachments: 0 })
    expect(extractMessage(multipart('multipart/mixed', [part('image/png', undefined, { filename: 'a.png' })]))).toEqual({
      body: '',
      truncated: false,
      links: [],
      attachments: 1,
    })
  })

  it('accepts a payload parsed from a format=full response', () => {
    const response = messageFullSchema.parse({
      id: 'm1',
      threadId: 't1',
      internalDate: '1731319200000',
      payload: { mimeType: 'text/plain', body: { data: utf8('Hola'), size: 4 } },
    })
    expect(extractMessage(response.payload).body).toBe('Hola')
  })
})

describe('extractMessage hostile input', () => {
  const nested = (inner: string, depth = 5000): string => '<div>'.repeat(depth) + inner + '</div>'.repeat(depth)

  it('converts 5 000 nested divs without throwing', () => {
    expect(() => extractMessage(html(nested('hondo')))).not.toThrow()
    expect(extractMessage(html(`<p>Arriba</p>${nested('hondo')}`)).body).toContain('Arriba')
  })

  it('converts 5 000 nested divs wrapped in an anchor without throwing', () => {
    const markup = `<a href="https://example.com/deep">${nested('hondo')}</a>`
    expect(() => extractMessage(html(markup))).not.toThrow()
    const result = extractMessage(html(markup))
    expect(result.links).toHaveLength(1)
    expect(result.links[0]!.url).toBe('https://example.com/deep')
    expect(result.links[0]!.text.length).toBeLessThanOrEqual(200)
  })

  it('keeps script, style and image content out of the link text and caps it at 200 characters', () => {
    const result = extractMessage(
      html('<a href="https://example.com/a">t<script>SECRET</script><style>.x{}</style><img alt="ALT">ext</a>'),
    )
    expect(result.links).toEqual([{ text: 'text', url: 'https://example.com/a' }])
    const long = extractMessage(html(`<a href="https://example.com/b">${'y'.repeat(500)}</a>`))
    expect(long.links[0]!.text).toBe('y'.repeat(200))
  })

  it('leaves out the title and head of a bare html document', () => {
    expect(extractMessage(html('<title>Boletín secreto</title><p>Hola</p>')).body).toBe('Hola')
    expect(extractMessage(html('<html><head><title>T</title><meta charset="utf-8"></head><p>Hola</p></html>')).body).toBe('Hola')
  })

  it('stops walking MIME parts below 50 levels', () => {
    let payload = plain('demasiado hondo')
    for (let level = 0; level < 60; level += 1) payload = multipart('multipart/mixed', [payload])
    expect(() => extractMessage(payload)).not.toThrow()
    expect(extractMessage(payload).body).toBe('')
    let shallow = plain('a mano')
    for (let level = 0; level < 10; level += 1) shallow = multipart('multipart/mixed', [shallow])
    expect(extractMessage(shallow).body).toBe('a mano')
  })

  it('visits at most 500 MIME parts', () => {
    const attachments = Array.from({ length: 1000 }, (_, n) => part('image/png', undefined, { filename: `${n}.png` }))
    const result = extractMessage(multipart('multipart/mixed', [plain('cuerpo'), ...attachments]))
    expect(result.body).toBe('cuerpo')
    expect(result.attachments).toBeLessThan(500)
    expect(result.attachments).toBeGreaterThan(400)
  })
})

describe('extractMessage links', () => {
  it('renders anchors as text [n] and returns the links apart', () => {
    const result = extractMessage(
      html('<p>Lee la <a href="https://example.com/docs">guía</a> y el <a href="http://example.com/faq">FAQ</a>.</p>'),
    )
    expect(result.body).toBe('Lee la guía [1] y el FAQ [2].')
    expect(result.links).toEqual([
      { text: 'guía', url: 'https://example.com/docs' },
      { text: 'FAQ', url: 'http://example.com/faq' },
    ])
  })

  it('keeps only http and https hrefs', () => {
    const result = extractMessage(
      html(
        [
          '<a href="javascript:alert(1)">a</a>',
          '<a href=" JavaScript:alert(1)">b</a>',
          '<a href="data:text/html,hola">c</a>',
          '<a href="vbscript:x">d</a>',
          '<a href="mailto:ana@example.com">e</a>',
          '<a href="/relative">f</a>',
          '<a>g</a>',
          '<a href="  HTTPS://Example.com/ok  ">ok</a>',
        ].join(' '),
      ),
    )
    expect(result.links).toEqual([{ text: 'ok', url: 'https://example.com/ok' }])
    expect(result.body).toBe('a b c d e f g ok [1]')
  })

  it('lists a repeated link once and reuses its number', () => {
    const result = extractMessage(html('<a href="https://example.com/x">uno</a> <a href="https://example.com/x">dos</a>'))
    expect(result.links).toEqual([{ text: 'uno', url: 'https://example.com/x' }])
    expect(result.body).toBe('uno [1] dos [1]')
  })

  it('uses the url as text for an anchor without text', () => {
    const result = extractMessage(html('<a href="https://example.com/img"><img src="https://example.com/i.png"></a>'))
    expect(result.links).toEqual([{ text: 'https://example.com/img', url: 'https://example.com/img' }])
  })

  it('keeps at most 50 links', () => {
    const anchors = Array.from({ length: 60 }, (_, n) => `<a href="https://example.com/${n}">l${n}</a>`).join(' ')
    const result = extractMessage(html(anchors))
    expect(result.links).toHaveLength(GMAIL_LINKS_MAX)
    expect(result.links.at(-1)).toEqual({ text: 'l49', url: 'https://example.com/49' })
    expect(result.body).toContain('l49 [50]')
    expect(result.body).toContain('l50 l51')
  })

  it('finds http(s) urls in plain text', () => {
    const result = extractMessage(
      plain('Mira https://example.com/a?b=1, y (http://example.com/c). Repite https://example.com/a?b=1 javascript:alert(1) ftp://example.com/f'),
    )
    expect(result.links).toEqual([
      { text: 'https://example.com/a?b=1', url: 'https://example.com/a?b=1' },
      { text: 'http://example.com/c', url: 'http://example.com/c' },
    ])
  })

  it('leaves out links longer than 2048 characters, in html and in plain text', () => {
    const long = `https://example.com/${'a'.repeat(GMAIL_URL_MAX)}`
    const edge = `https://example.com/${'b'.repeat(GMAIL_URL_MAX - 'https://example.com/'.length)}`
    const fromHtml = extractMessage(html(`<a href="${long}">larga</a> <a href="${edge}">justa</a>`))
    expect(fromHtml.links).toEqual([{ text: 'justa', url: edge }])
    expect(fromHtml.body).toBe('larga justa [1]')
    expect(extractMessage(plain(`${long} ${edge}`)).links).toEqual([{ text: edge.slice(0, 200), url: edge }])
  })

  it('keeps at most 50 plain-text links', () => {
    const text = Array.from({ length: 60 }, (_, n) => `https://example.com/${n}`).join('\n')
    expect(extractMessage(plain(text)).links).toHaveLength(GMAIL_LINKS_MAX)
  })
})
