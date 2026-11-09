import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { PRODUCTION_CSP, injectCspMeta } from './src/shared/security/csp'

/** Adds the strict CSP meta tag to built HTML only; dev gets a relaxed header from the main process. */
function productionCsp(): Plugin {
  return {
    name: 'notch:production-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => injectCspMeta(html, PRODUCTION_CSP),
    },
  }
}

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    root: 'src/renderer',
    plugins: [react(), tailwindcss(), productionCsp()],
    build: {
      minify: true,
      rolldownOptions: {
        input: {
          notch: resolve('src/renderer/notch/index.html'),
          'control-center': resolve('src/renderer/control-center/index.html'),
        },
      },
    },
  },
})
