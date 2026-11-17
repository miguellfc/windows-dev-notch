import { describe, expect, it } from 'vitest'
import { DEV_CSP, PRODUCTION_CSP, TAURI_PRODUCTION_CSP, injectCspMeta } from '../../../src/shared/security/csp'
import { productionCsp } from '../../../src/shared/security/vite-csp'

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

describe('Tauri production policy', () => {
  it('only adds Tauri IPC to connect-src', () => {
    expect(TAURI_PRODUCTION_CSP).toContain("connect-src 'self' ipc: http://ipc.localhost;")
    const strip = (policy: string) => policy.split('; ').filter((directive) => !directive.startsWith('connect-src'))
    expect(strip(TAURI_PRODUCTION_CSP)).toEqual(strip(PRODUCTION_CSP))
  })

  it('leaves the Electron policy without Tauri IPC', () => {
    expect(PRODUCTION_CSP).toContain("connect-src 'self';")
    expect(PRODUCTION_CSP).not.toContain('ipc')
  })
})

describe('productionCsp plugin', () => {
  const transform = (policy: string) => {
    const hook = productionCsp(policy).transformIndexHtml as { handler: (html: string) => string }
    return (html: string) => hook.handler(html)
  }

  it('injects the given policy', () => {
    const page = '<html><head></head><body></body></html>'
    expect(transform(TAURI_PRODUCTION_CSP)(page)).toContain(`content="${TAURI_PRODUCTION_CSP}"`)
    expect(transform(PRODUCTION_CSP)(page)).toContain(`content="${PRODUCTION_CSP}"`)
  })

  it('still fails the build for a page without <head>', () => {
    expect(() => transform(TAURI_PRODUCTION_CSP)('<html><body></body></html>')).toThrow(/head/)
  })
})
