export interface QuitFlushOptions {
  /** Saves pending state; may settle immediately when there is nothing to write. */
  flush: () => Promise<void>
  /** Upper bound on the flush, so quitting never hangs on the disk. */
  timeoutMs: number
  /** Asks the app to quit again (`app.quit`). */
  quit: () => void
  /** Final cleanup, run on the second `will-quit` right before the app exits. */
  cleanup: () => void
  /** Run once when the first `will-quit` starts the flush (e.g. stop periodic writers). */
  onFlushStart?: () => void
}

/**
 * Two-pass `will-quit` handler: the first pass cancels the quit, flushes (bounded by a timeout)
 * and quits again; the second pass runs the cleanup and lets the app exit.
 * If `will-quit` fires again while the flush is still pending (a second `app.quit()`), that pass
 * runs the cleanup and lets the app exit without waiting for the flush.
 */
export const createQuitFlush = ({ flush, timeoutMs, quit, cleanup, onFlushStart }: QuitFlushOptions) => {
  let flushed = false
  return (event: { preventDefault(): void }): void => {
    if (flushed) {
      cleanup()
      return
    }
    flushed = true
    event.preventDefault()
    onFlushStart?.()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))
    // A sync throw or a rejection from the flush must still quit: it never blocks the exit.
    let pending: Promise<void>
    try {
      pending = Promise.resolve(flush())
    } catch (error) {
      pending = Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    void Promise.race([pending, timeout])
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer)
        // Never quit from a microtask: when the flush has nothing to write it settles before
        // Electron finishes dispatching this prevented `will-quit`, while it still counts as
        // quitting, so that `app.quit()` would be silently ignored and the app would never exit.
        setTimeout(quit, 0)
      })
  }
}
