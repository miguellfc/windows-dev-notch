// IIFE entry injected into every app webview (see `vite.bridge.config.mts`). It runs after
// Tauri's own scripts, so `__TAURI_INTERNALS__` is available (withGlobalTauri stays off).
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { installBridge } from './bridge'

interface InternalsMetadata {
  metadata: { currentWebview: { label: string } }
}

const label = (window as unknown as { __TAURI_INTERNALS__: InternalsMetadata }).__TAURI_INTERNALS__.metadata.currentWebview
  .label

installBridge({
  invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown>),
  // Listen only for events aimed at this window: an `Any` listener would also get
  // events the main process sends to the other window.
  listen: (event, cb) => listen(event, (message) => cb(message.payload), { target: label }),
})
