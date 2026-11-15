import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// Bundles the `window.notch` bridge into one self-contained IIFE that the Rust crate embeds
// with `include_str!` (src-tauri/src/ipc/mod.rs) and injects as an initialization script.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'src-tauri/gen',
    // gen/ also holds Tauri's generated schemas.
    emptyOutDir: false,
    minify: true,
    sourcemap: false,
    lib: {
      entry: resolve('src/tauri-bridge/main.ts'),
      formats: ['iife'],
      name: 'NotchBridge',
      fileName: () => 'bridge.js',
    },
  },
})
