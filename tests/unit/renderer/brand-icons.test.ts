import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PLATFORM_ICONS } from '../../../src/renderer/notch/code-review/icons'
import { ClaudeMark, GithubMark, GitlabMark, GmailMark } from '../../../src/renderer/shared/brand-icons'

describe.each([
  ['GmailMark', GmailMark],
  ['GithubMark', GithubMark],
  ['ClaudeMark', ClaudeMark],
])('%s', (_, Icon) => {
  const html = renderToStaticMarkup(createElement(Icon, { size: 13, strokeWidth: 1.8, 'aria-hidden': 'true' }))
  it('is a 24×24 svg at the requested size', () => {
    expect(html).toMatch(/^<svg[^>]*width="13"[^>]*height="13"/)
    expect(html).toContain('viewBox="0 0 24 24"')
  })
  it('fills every path with currentColor and no stroke', () => {
    const paths = html.match(/<path[^>]*>/g) ?? []
    expect(paths.length).toBeGreaterThan(0)
    for (const p of paths) {
      expect(p).toContain('fill="currentColor"')
      expect(p).toContain('stroke="none"')
    }
  })
  it('has no internal ids', () => {
    expect(html).not.toMatch(/\sid="/)
  })
})

it('GitlabMark keeps the stroked outline', () => {
  expect(renderToStaticMarkup(createElement(GitlabMark))).not.toContain('fill="currentColor"')
})

it('PLATFORM_ICONS maps to the brand marks', () => {
  expect(PLATFORM_ICONS).toEqual({ github: GithubMark, gitlab: GitlabMark })
})
