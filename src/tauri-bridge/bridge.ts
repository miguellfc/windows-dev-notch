import { buildApi } from '../shared/ipc/build-api'

/** The parts of Tauri's IPC the bridge needs; the IIFE entry adapts `__TAURI_INTERNALS__`. */
export interface TauriInternals {
  invoke(cmd: string, args: unknown): Promise<unknown>
  listen(event: string, cb: (payload: unknown) => void): Promise<() => void>
}

/** Where the bridge installs itself: `globalThis` (the page's `window`) in the app. */
export interface BridgeTarget {
  document?: { documentElement: { dataset: Record<string, string | undefined> } }
}

/** The single Rust command behind every channel (`src-tauri/src/ipc/mod.rs`). */
export const IPC_COMMAND = 'notch_ipc'

/**
 * Defines `window.notch` (non-writable, non-configurable, frozen), the same API the Electron
 * preload exposes, on top of the `notch_ipc` command and Tauri events.
 */
export function installBridge(internals: TauriInternals, target: BridgeTarget = globalThis as BridgeTarget): void {
  const api = buildApi(
    (channel, input) => internals.invoke(IPC_COMMAND, { channel, input }),
    (event, listener) => {
      let active = true
      const forward = listener as (payload: unknown) => void
      // Handled right away: a refused registration (e.g. a missing event permission) must not
      // become an unhandled rejection. Only the event name is logged, never the error's detail.
      const unlisten: Promise<(() => void) | undefined> = internals
        .listen(event, (payload) => {
          if (active) forward(payload)
        })
        .catch(() => {
          console.warn(`notch bridge: could not listen to ${event}`)
          return undefined
        })
      return () => {
        if (!active) return
        active = false
        // Unlisten once the registration settles, even if unsubscribe came first.
        unlisten.then((stop) => stop?.()).catch(() => undefined)
      }
    },
  )

  Object.defineProperty(target, 'notch', { value: api, writable: false, configurable: false, enumerable: true })
  if (target.document) target.document.documentElement.dataset['runtime'] = 'tauri'
}
