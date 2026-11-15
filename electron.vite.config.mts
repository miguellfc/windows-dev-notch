import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { productionCsp } from './src/shared/security/vite-csp'

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
