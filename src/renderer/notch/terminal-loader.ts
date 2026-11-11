import { lazy } from 'react'

let pending: Promise<typeof import('./TerminalView')> | undefined

/**
 * xterm (and its CSS) is the largest part of the notch bundle and most sessions never open the
 * terminal, so it loads on demand. The import is shared: a preload on intent (pointer or focus on
 * the tile) and the lazy view resolve the same chunk once.
 */
export const loadTerminal = (): Promise<typeof import('./TerminalView')> =>
  (pending ??= import('./TerminalView').catch((error: unknown) => {
    // A failed load is not cached: the next open (or preload) tries again.
    pending = undefined
    throw error
  }))

export const LazyTerminalView = lazy(() => loadTerminal().then((module) => ({ default: module.TerminalView })))
