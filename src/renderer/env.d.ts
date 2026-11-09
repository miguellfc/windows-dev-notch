import type { NotchApi } from '../shared/ipc/api'

declare global {
  interface Window {
    readonly notch: NotchApi
  }
}

export {}
