import type { Plugin } from 'vite'
import { injectCspMeta } from './csp'

/**
 * Adds the strict CSP meta tag to built HTML only; dev gets a relaxed header from the host process.
 * The Tauri build passes TAURI_PRODUCTION_CSP as `policy`.
 */
export function productionCsp(policy: string): Plugin {
  return {
    name: 'notch:production-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => injectCspMeta(html, policy),
    },
  }
}
