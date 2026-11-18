import { useSyncExternalStore } from 'react'

// Node-tested module (tsconfig.node has no DOM types), so the browser globals are typed locally.
interface OnlineTarget {
  navigator?: { onLine: boolean }
  addEventListener(type: 'online' | 'offline', listener: () => void): void
  removeEventListener(type: 'online' | 'offline', listener: () => void): void
}
const host = (): OnlineTarget => globalThis as unknown as OnlineTarget

/** Whether the machine has a network: `navigator.onLine`, or true where there is no navigator. */
export function onlineFrom(nav: { onLine: boolean } | undefined): boolean {
  return nav ? nav.onLine : true
}

function subscribe(notify: () => void): () => void {
  const target = host()
  target.addEventListener('online', notify)
  target.addEventListener('offline', notify)
  return () => {
    target.removeEventListener('online', notify)
    target.removeEventListener('offline', notify)
  }
}

const snapshot = (): boolean => onlineFrom(host().navigator)

/** Live connection state from `navigator.onLine` and the window's `online`/`offline` events. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => true)
}
