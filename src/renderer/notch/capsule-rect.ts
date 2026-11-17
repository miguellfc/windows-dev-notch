/** The capsule's box in the window, in DIP (CSS px), as `notch:capsule-rect` takes it. */
export interface CapsuleRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface Measurable {
  getBoundingClientRect(): { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
}

interface SizeObserver<T> {
  observe(target: T): void
  disconnect(): void
}

type SizeObserverConstructor<T> = new (callback: () => void) => SizeObserver<T>

export interface CapsuleRectReporter<T extends Measurable> {
  /** Measures `element` now and whenever it resizes; returns the cleanup. */
  observe(element: T): () => void
  /** Measures the observed element again (the end of a layout animation moves no size). */
  refresh(): void
}

/**
 * Tells main where the painted capsule is, so it can let clicks through everywhere else (Tauri
 * polls the cursor against this box). Only a box that changed is sent, and never one the contract
 * refuses: an empty box is skipped and a transform that pushes it past the window's edge is clamped.
 */
export function createCapsuleRectReporter<T extends Measurable>(
  send: (rect: CapsuleRect) => void,
  Observer: SizeObserverConstructor<T>,
): CapsuleRectReporter<T> {
  let last: CapsuleRect | null = null
  let current: T | null = null

  const report = (element: T) => {
    const box = element.getBoundingClientRect()
    if (!(box.width > 0 && box.height > 0)) return
    const rect = { x: Math.max(0, box.x), y: Math.max(0, box.y), width: box.width, height: box.height }
    if (last && last.x === rect.x && last.y === rect.y && last.width === rect.width && last.height === rect.height) return
    last = rect
    send(rect)
  }

  return {
    observe(element) {
      current = element
      // A ResizeObserver also fires once when it starts observing: that is the first report.
      const observer = new Observer(() => report(element))
      observer.observe(element)
      return () => {
        observer.disconnect()
        if (current === element) current = null
      }
    },
    refresh() {
      if (current) report(current)
    },
  }
}
