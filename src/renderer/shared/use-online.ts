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

/**
 * The connection the capsule shows. `navigator.onLine` alone stays true on a network without
 * internet, so main's reading (Windows' connectivity hint, `reported`) wins when it has one. But
 * navigator offline (no network adapter connected) is reliable and immediate, so it wins over a
 * sample that is up to 3 s old and still says online. With no reading (`null`) navigator decides.
 */
export function connectionOnline(reported: boolean | null, navigatorOnline: boolean): boolean {
  return navigatorOnline && (reported ?? true)
}

/** Live connection state from `navigator.onLine` and the window's `online`/`offline` events. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => true)
}
