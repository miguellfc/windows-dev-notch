/** Strict policy injected into every built HTML page. */
export const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ')

/**
 * Inserts the CSP meta tag as the first element of <head>. Throws when there is no <head>,
 * so a build can never ship a page without a policy.
 */
export function injectCspMeta(html: string, policy: string): string {
  const head = /<head(\s[^>]*)?>/i
  if (!head.test(html)) throw new Error('Cannot inject CSP: page has no <head> element')
  return html.replace(head, (tag) => `${tag}\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`)
}

/** Dev-only policy: Vite's HMR needs inline styles and the React refresh preamble, never eval. */
export const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws:",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ')
