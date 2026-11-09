import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNotchController, type NotchSurface } from '../../../src/main/windows/notch-controller'
import { windowBoundsFor } from '../../../src/shared/notch/geometry'
import { createMemoryLogger } from '../helpers/memory-logger'

const workArea = { x: 0, y: 0, width: 1920, height: 1032 }

function setup() {
  const calls: string[] = []
  const surface: NotchSurface = {
    setBounds: (rect) => calls.push(`bounds:${rect.width}x${rect.height}`),
    show: () => calls.push('show'),
    hide: () => calls.push('hide'),
    focus: () => calls.push('focus'),
    blur: () => calls.push('blur'),
    setIgnoreMouse: (ignore) => calls.push(`ignore:${ignore}`),
    sendMode: (mode) => calls.push(`mode:${mode}`),
  }
  const onModeChange = vi.fn()
  const controller = createNotchController({ surface, workArea, settleTimeoutMs: 400, logger: createMemoryLogger(), onModeChange })
  controller.start()
  calls.length = 0
  return { controller, calls, onModeChange }
}

const size = (mode: Parameters<typeof windowBoundsFor>[0]) => {
  const b = windowBoundsFor(mode, workArea)
  return `bounds:${b.width}x${b.height}`
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('notch controller', () => {
  it('starts compact, visible and click-through', () => {
    const calls: string[] = []
    const surface = {
      setBounds: (r: { width: number; height: number }) => calls.push(`bounds:${r.width}x${r.height}`),
      show: () => calls.push('show'),
      hide: () => calls.push('hide'),
      focus: () => calls.push('focus'),
      blur: () => calls.push('blur'),
      setIgnoreMouse: (i: boolean) => calls.push(`ignore:${i}`),
      sendMode: (m: string) => calls.push(`mode:${m}`),
    }
    createNotchController({ surface, workArea, logger: createMemoryLogger() }).start()
    expect(calls).toEqual([size('compact'), 'ignore:true', 'mode:compact', 'show'])
  })

  it('applies events that arrive before the window is ready once it starts', () => {
    const calls: string[] = []
    const surface: NotchSurface = {
      setBounds: (r) => calls.push(`bounds:${r.width}x${r.height}`),
      show: () => calls.push('show'),
      hide: () => calls.push('hide'),
      focus: () => calls.push('focus'),
      blur: () => calls.push('blur'),
      setIgnoreMouse: (i) => calls.push(`ignore:${i}`),
      sendMode: (m) => calls.push(`mode:${m}`),
    }
    const controller = createNotchController({ surface, workArea, logger: createMemoryLogger() })
    controller.dispatch({ type: 'foreground', verdict: 'hidden' })
    expect(calls).toEqual([])
    controller.start()
    expect(calls).toEqual(['ignore:true', 'mode:hidden', 'hide'])

    calls.length = 0
    const other = createNotchController({ surface, workArea, logger: createMemoryLogger() })
    other.dispatch({ type: 'foreground', verdict: 'mini' })
    other.start()
    expect(calls).toEqual([size('mini'), 'ignore:true', 'mode:mini', 'show'])
  })

  it('grows the window before animating when expanding, and takes focus', () => {
    const { controller, calls, onModeChange } = setup()
    controller.dispatch({ type: 'expand' })
    expect(calls).toEqual([size('expanded'), 'mode:expanded', 'focus'])
    expect(onModeChange).toHaveBeenCalledWith('expanded')
  })

  it('animates before shrinking and waits for the renderer to settle', () => {
    const { controller, calls } = setup()
    controller.dispatch({ type: 'expand' })
    calls.length = 0
    controller.dispatch({ type: 'dismiss' })
    expect(calls).toEqual(['mode:compact', 'blur'])
    controller.settled()
    expect(calls).toEqual(['mode:compact', 'blur', size('compact')])
  })

  it('shrinks anyway after a timeout if the renderer never settles', () => {
    const { controller, calls } = setup()
    controller.dispatch({ type: 'expand' })
    controller.dispatch({ type: 'dismiss' })
    calls.length = 0
    vi.advanceTimersByTime(400)
    expect(calls).toEqual([size('compact')])
  })

  it('ignores a repeated dismiss instead of cutting the animation (M0)', () => {
    const { controller, calls } = setup()
    controller.dispatch({ type: 'expand' })
    controller.dispatch({ type: 'dismiss' })
    calls.length = 0
    controller.dispatch({ type: 'dismiss' })
    expect(calls).toEqual([])
  })

  it('cancels a pending shrink when the user re-expands mid-animation', () => {
    const { controller, calls } = setup()
    controller.dispatch({ type: 'expand' })
    controller.dispatch({ type: 'dismiss' })
    controller.dispatch({ type: 'expand' })
    calls.length = 0
    vi.advanceTimersByTime(1000)
    controller.settled()
    expect(calls).toEqual([])
  })

  it('accepts clicks only while the pointer is over the capsule', () => {
    const { controller, calls } = setup()
    controller.dispatch({ type: 'pointer', inside: true })
    expect(calls).toContain('ignore:false')
    controller.dispatch({ type: 'pointer', inside: false })
    expect(calls.at(-1)).toBe('ignore:true')
  })

  it('hides immediately and shows again on the right size', () => {
    const { controller, calls } = setup()
    controller.dispatch({ type: 'foreground', verdict: 'hidden' })
    expect(calls).toEqual(['mode:hidden', 'hide', 'ignore:true'])
    calls.length = 0
    controller.dispatch({ type: 'foreground', verdict: 'mini' })
    expect(calls).toEqual([size('mini'), 'mode:mini', 'show'])
  })

  it('repositions on a new work area', () => {
    const { controller, calls } = setup()
    controller.setWorkArea({ x: 1920, y: 0, width: 2560, height: 1400 })
    expect(calls).toEqual([size('compact')])
  })

  it('makes the window click-through again when it hides', () => {
    const { controller, calls } = setup()
    controller.dispatch({ type: 'pointer', inside: true })
    calls.length = 0
    controller.dispatch({ type: 'user-visibility', hidden: true })
    expect(calls).toEqual(['mode:hidden', 'hide', 'ignore:true'])
  })

  it('keeps the window large while a shrink is pending, even if a smaller mode arrives', () => {
    const { controller, calls } = setup()
    controller.dispatch({ type: 'expand' })
    controller.dispatch({ type: 'dismiss' })
    calls.length = 0
    controller.dispatch({ type: 'pointer', inside: true })
    expect(calls).toEqual(['mode:peek', 'ignore:false'])
    controller.settled()
    expect(calls.at(-1)).toBe(size('peek'))
  })

  it('stops pending work on dispose', () => {
    const { controller, calls } = setup()
    controller.dispatch({ type: 'expand' })
    controller.dispatch({ type: 'dismiss' })
    controller.dispose()
    calls.length = 0
    vi.advanceTimersByTime(1000)
    controller.settled()
    controller.dispatch({ type: 'expand' })
    expect(calls).toEqual([])
  })

  it('reports the current mode', () => {
    const { controller } = setup()
    controller.dispatch({ type: 'toggle' })
    expect(controller.mode()).toBe('expanded')
  })

  describe('terminal panel', () => {
    it('grows into the terminal from the capsule and takes focus', () => {
      const { controller, calls } = setup()
      controller.dispatch({ type: 'open-integration', id: 'terminal' })
      expect(calls).toEqual([size('terminal'), 'mode:terminal', 'focus'])
    })

    it('keeps focus while moving between the panel and the terminal', () => {
      const { controller, calls } = setup()
      controller.dispatch({ type: 'expand' })
      calls.length = 0
      controller.dispatch({ type: 'open-integration', id: 'terminal' })
      expect(calls).toEqual([size('terminal'), 'mode:terminal'])
      calls.length = 0
      controller.dispatch({ type: 'back' })
      expect(calls).toEqual(['mode:expanded'])
      controller.settled()
      expect(calls).toEqual(['mode:expanded', size('expanded')])
    })

    it('gives focus back when the terminal closes', () => {
      const { controller, calls } = setup()
      controller.dispatch({ type: 'open-integration', id: 'terminal' })
      calls.length = 0
      controller.dispatch({ type: 'dismiss' })
      expect(calls).toEqual(['mode:compact', 'blur'])
    })
  })
})
