import { describe, expect, it } from 'vitest'
import { createCapsuleRectReporter, type CapsuleRect } from '../../../src/renderer/notch/capsule-rect'

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** A capsule element whose box the test moves, and a ResizeObserver the test triggers. */
function setup() {
  const element = { box: { x: 296, y: 6, width: 168, height: 36 } as Box, getBoundingClientRect: () => element.box }
  const observers: { callback: () => void; target: unknown; connected: boolean }[] = []
  class FakeResizeObserver {
    private readonly entry: (typeof observers)[number]
    constructor(callback: () => void) {
      this.entry = { callback, target: null, connected: false }
      observers.push(this.entry)
    }
    observe(target: unknown) {
      this.entry.target = target
      this.entry.connected = true
    }
    disconnect() {
      this.entry.connected = false
    }
  }
  const sent: CapsuleRect[] = []
  const reporter = createCapsuleRectReporter((rect) => sent.push(rect), FakeResizeObserver)
  const resize = () => observers.filter((o) => o.connected).forEach((o) => o.callback())
  return { element, observers, sent, reporter, resize }
}

describe('capsule rect reporter', () => {
  it('capsule reports its rect once per change', () => {
    const { element, sent, reporter, resize } = setup()
    const stop = reporter.observe(element)
    resize()
    resize()
    // The end of a layout animation re-measures, but an unchanged box is not sent again.
    reporter.refresh()
    expect(sent).toEqual([{ x: 296, y: 6, width: 168, height: 36 }])

    element.box = { x: 201, y: 6, width: 358, height: 36 }
    resize()
    reporter.refresh()
    expect(sent).toEqual([
      { x: 296, y: 6, width: 168, height: 36 },
      { x: 201, y: 6, width: 358, height: 36 },
    ])
    stop()
  })

  it('a layout animation that ends on a new box reports it', () => {
    const { element, sent, reporter, resize } = setup()
    reporter.observe(element)
    resize()
    // Mid-morph the observer saw the start box; the animation ends on the final one.
    element.box = { x: 120, y: 6, width: 520, height: 504 }
    reporter.refresh()
    expect(sent.at(-1)).toEqual({ x: 120, y: 6, width: 520, height: 504 })
  })

  it('stops observing once disconnected, and refresh does nothing without an element', () => {
    const { element, observers, sent, reporter, resize } = setup()
    reporter.refresh()
    const stop = reporter.observe(element)
    expect(observers[0]?.target).toBe(element)
    stop()
    expect(observers[0]?.connected).toBe(false)
    element.box = { x: 1, y: 1, width: 2, height: 2 }
    resize()
    reporter.refresh()
    expect(sent).toEqual([])
  })

  it('never sends a box the contract refuses', () => {
    const { element, sent, reporter, resize } = setup()
    reporter.observe(element)
    element.box = { x: 10, y: 6, width: 0, height: 36 }
    resize()
    expect(sent).toEqual([])
    // A transform may push the box slightly off the window's edge: clamp to the window.
    element.box = { x: -0.5, y: -1, width: 168, height: 36 }
    resize()
    expect(sent).toEqual([{ x: 0, y: 0, width: 168, height: 36 }])
  })
})
