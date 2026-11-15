import { describe, expect, it } from 'vitest'
import { DEV_CSP, PRODUCTION_CSP, injectCspMeta } from '../../../src/shared/security/csp'

describe('injectCspMeta', () => {
  it('inserts the policy as the first element of <head>', () => {
    const html = injectCspMeta('<html><head lang="es"><meta charset="UTF-8"></head></html>', "default-src 'none'")
    expect(html).toBe(
      `<html><head lang="es">\n    <meta http-equiv="Content-Security-Policy" content="default-src 'none'" /><meta charset="UTF-8"></head></html>`,
    )
  })

  it('fails the build instead of shipping a page without a policy', () => {
    expect(() => injectCspMeta('<html><body></body></html>', PRODUCTION_CSP)).toThrow(/head/)
  })
})

describe('Content Security Policy', () => {
  it('production policy allows no inline or eval script', () => {
    expect(PRODUCTION_CSP).not.toContain('unsafe-eval')
    expect(PRODUCTION_CSP).toMatch(/script-src 'self'(;|$)/)
    // Inline styles are injected at runtime; only styles are relaxed.
    expect(PRODUCTION_CSP).toContain("style-src 'self' 'unsafe-inline'")
    expect(PRODUCTION_CSP.match(/unsafe-inline/g)).toHaveLength(1)
    expect(PRODUCTION_CSP).toContain("default-src 'none'")
    expect(PRODUCTION_CSP).toContain("script-src 'self'")
    expect(PRODUCTION_CSP).toContain("object-src 'none'")
  })

  it('dev policy never allows eval', () => {
    expect(DEV_CSP).not.toContain('unsafe-eval')
  })
})
