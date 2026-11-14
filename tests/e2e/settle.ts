import type { Page } from '@playwright/test'

/**
 * Stable replacement for fixed sleeps before a screenshot. Resolves once fonts are loaded and, for two
 * consecutive painted frames, no animation is running (the 120 ms opacity cross-fade is WAAPI) and the
 * capsule, if any, has reached the size of its current mode (the layout morph is a JS-driven transform,
 * so its bounding box equals the target width/height only when the morph is over).
 */
export const settle = (page: Page): Promise<void> =>
  page.evaluate(async () => {
    type Rect = { width: number; height: number }
    type Doc = {
      fonts: { ready: Promise<unknown> }
      getAnimations: () => { finished: Promise<unknown>; effect: { getComputedTiming: () => { endTime: number | string } } | null }[]
      querySelector: (selector: string) => { getBoundingClientRect: () => Rect; style: Rect & { width: string; height: string } } | null
    }
    const w = globalThis as unknown as { document: Doc; requestAnimationFrame: (cb: () => void) => void }
    // Endless loops (spinners, pulses) never finish and are not mid-fade artifacts.
    const finite = () => w.document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
    const frame = () => new Promise<void>((resolve) => w.requestAnimationFrame(() => resolve()))
    const atTargetSize = (): boolean => {
      const el = w.document.querySelector('[data-testid="notch-capsule"]')
      if (!el) return true
      const box = el.getBoundingClientRect()
      return Math.abs(box.width - parseFloat(el.style.width)) < 0.5 && Math.abs(box.height - parseFloat(el.style.height)) < 0.5
    }
    await w.document.fonts.ready
    let stable = 0
    for (let i = 0; i < 300 && stable < 2; i++) {
      await Promise.all(finite().map((a) => a.finished.catch(() => undefined)))
      await frame()
      stable = finite().length === 0 && atTargetSize() ? stable + 1 : 0
    }
  })
