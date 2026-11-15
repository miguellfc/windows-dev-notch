import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { TAURI_PRODUCTION_CSP } from './src/shared/security/csp'
import { productionCsp } from './src/shared/security/vite-csp'

// Renderer build for the Tauri shell; same sources as the Electron renderer.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react(), tailwindcss(), productionCsp(TAURI_PRODUCTION_CSP)],
  server: { port: 5174, strictPort: true },
  build: {
    outDir: '../../out/tauri-renderer',
    emptyOutDir: true,
    minify: true,
    rolldownOptions: {
      input: {
        notch: resolve('src/renderer/notch/index.html'),
        'control-center': resolve('src/renderer/control-center/index.html'),
      },
    },
  },
})
