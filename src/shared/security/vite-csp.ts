import type { Plugin } from 'vite'
import { PRODUCTION_CSP, injectCspMeta } from './csp'

/**
 * Adds the strict CSP meta tag to built HTML only; dev gets a relaxed header from the host process.
 * `policy` defaults to Electron's; the Tauri build passes TAURI_PRODUCTION_CSP.
 */
export function productionCsp(policy: string = PRODUCTION_CSP): Plugin {
  return {
    name: 'notch:production-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => injectCspMeta(html, policy),
    },
  }
}
