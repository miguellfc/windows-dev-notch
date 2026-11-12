import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNotchController, MAIL_ALERT_MS, type NotchSurface } from '../../../src/main/windows/notch-controller'
import { windowBoundsFor } from '../../../src/shared/notch/geometry'
import { createMemoryLogger } from '../helpers/memory-logger'

const workArea = { x: 0, y: 0, width: 1920, height: 1032 }

function setup() {
  const calls: string[] = []
  const mailAlerts: boolean[] = []
  const surface: NotchSurface = {
    setBounds: (rect) => calls.push(`bounds:${rect.width}x${rect.height}`),
    show: () => calls.push('show'),
    hide: () => calls.push('hide'),
    focus: () => calls.push('focus'),
    blur: () => calls.push('blur'),
    setIgnoreMouse: (ignore) => calls.push(`ignore:${ignore}`),
    sendMode: (mode) => calls.push(`mode:${mode}`),
    sendMailAlert: (on) => mailAlerts.push(on),
  }
  const onModeChange = vi.fn()
  const controller = createNotchController({ surface, workArea, settleTimeoutMs: 400, logger: createMemoryLogger(), onModeChange })
  controller.start()
  calls.length = 0
  mailAlerts.length = 0
  return { controller, calls, mailAlerts, onModeChange }
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
      sendMailAlert: () => {},
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
      sendMailAlert: () => {},
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

  describe('system panel', () => {
    it('grows into the system panel and takes focus, then gives it back on dismiss', () => {
      const { controller, calls } = setup()
      controller.dispatch({ type: 'open-integration', id: 'system' })
      expect(calls).toEqual([size('system'), 'mode:system', 'focus'])
      calls.length = 0
      controller.dispatch({ type: 'dismiss' })
      expect(calls).toEqual(['mode:compact', 'blur'])
    })

    it('keeps focus when going back to the integrations row', () => {
      const { controller, calls } = setup()
      controller.dispatch({ type: 'open-integration', id: 'system' })
      calls.length = 0
      controller.dispatch({ type: 'back' })
      // The home panel's window (308, room for Claude sessions) is taller than the system view's (280).
      expect(calls).toEqual([size('expanded'), 'mode:expanded'])
    })
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

describe('notch controller: attention', () => {
  it('grows into the alert capsule without taking focus', () => {
    const { controller, calls } = setup()
    controller.dispatch({ type: 'attention', on: true })
    expect(calls).toEqual([size('alert'), 'mode:alert'])
  })

  it('takes focus when expanding into the permission card and gives it back on dismiss', () => {
    const { controller, calls } = setup()
    controller.dispatch({ type: 'attention', on: true })
    calls.length = 0
    controller.dispatch({ type: 'expand' })
    expect(calls).toEqual([size('permission'), 'mode:permission', 'focus'])
    calls.length = 0
    controller.dispatch({ type: 'dismiss' })
    expect(calls).toEqual(['mode:alert', 'blur'])
  })

  it('grows the window before animating from the permission card into the taller reminders panel', () => {
    // Permission (480×300) has more area than reminders (420×320) but a shorter window.
    const { controller, calls } = setup()
    controller.dispatch({ type: 'attention', on: true })
    controller.dispatch({ type: 'expand' })
    calls.length = 0
    controller.dispatch({ type: 'open-integration', id: 'reminders' })
    expect(calls).toEqual([size('reminders'), 'mode:reminders'])
  })

  it('keeps focus between the permission card and the panel', () => {
    const { controller, calls } = setup()
    controller.dispatch({ type: 'attention', on: true })
    controller.dispatch({ type: 'expand' })
    calls.length = 0
    controller.dispatch({ type: 'attention', on: false })
    // The home panel's window (308) is taller than the permission card's (300): it grows first.
    expect(calls).toEqual([size('expanded'), 'mode:expanded'])
  })
})

describe('notch controller: reminders', () => {
  it('grows into the alert capsule without taking focus when a reminder is due', () => {
    const { controller, calls } = setup()
    controller.dispatch({ type: 'reminders', due: true })
    expect(calls).toEqual([size('alert'), 'mode:alert'])
  })

  it('grows before animating into the reminders panel and takes focus', () => {
    const { controller, calls } = setup()
    controller.dispatch({ type: 'reminders', due: true })
    calls.length = 0
    controller.dispatch({ type: 'expand' })
    expect(calls).toEqual([size('reminders'), 'mode:reminders', 'focus'])
  })

  it('takes focus when opening the reminders integration and gives it back on dismiss', () => {
    const { controller, calls } = setup()
    controller.dispatch({ type: 'open-integration', id: 'reminders' })
    expect(calls).toEqual([size('reminders'), 'mode:reminders', 'focus'])
    calls.length = 0
    controller.dispatch({ type: 'dismiss' })
    expect(calls).toEqual(['mode:compact', 'blur'])
  })

  it('keeps the panel open and focused when the reminder is cleared', () => {
    const { controller, calls } = setup()
    controller.dispatch({ type: 'reminders', due: true })
    controller.dispatch({ type: 'expand' })
    calls.length = 0
    controller.dispatch({ type: 'reminders', due: false })
    expect(calls).toEqual([])
  })
})

describe('notch controller: new mail', () => {
  it('grows into the alert capsule without taking focus and goes back to compact after 6 s', () => {
    const { controller, calls } = setup()
    controller.dispatch({ type: 'mail', on: true })
    expect(calls).toEqual([size('alert'), 'mode:alert'])
    expect(MAIL_ALERT_MS).toBe(6000)
    vi.advanceTimersByTime(5999)
    expect(controller.mode()).toBe('alert')
    vi.advanceTimersByTime(1)
    expect(controller.mode()).toBe('compact')
  })

  it('restarts the 6 s when more mail arrives while it shows', () => {
    const { controller } = setup()
    controller.dispatch({ type: 'mail', on: true })
    vi.advanceTimersByTime(4000)
    controller.dispatch({ type: 'mail', on: true })
    vi.advanceTimersByTime(4000)
    expect(controller.mode()).toBe('alert')
    vi.advanceTimersByTime(2000)
    expect(controller.mode()).toBe('compact')
  })

  it('is ignored while a panel is open, and does not show after it closes', () => {
    const { controller, calls } = setup()
    controller.dispatch({ type: 'open-integration', id: 'notes' })
    calls.length = 0
    controller.dispatch({ type: 'mail', on: true })
    expect(calls).toEqual([])
    controller.dispatch({ type: 'dismiss' })
    expect(controller.mode()).toBe('compact')
  })

  it('never covers a permission or a due reminder; expanding opens their view, not gmail', () => {
    const { controller } = setup()
    controller.dispatch({ type: 'attention', on: true })
    controller.dispatch({ type: 'mail', on: true })
    controller.dispatch({ type: 'expand' })
    expect(controller.mode()).toBe('permission')

    const other = setup().controller
    other.dispatch({ type: 'mail', on: true })
    other.dispatch({ type: 'reminders', due: true })
    other.dispatch({ type: 'expand' })
    expect(other.mode()).toBe('reminders')
  })

  it('opens the gmail view and takes focus when expanding from the mail alert', () => {
    const { controller, calls } = setup()
    controller.dispatch({ type: 'mail', on: true })
    calls.length = 0
    controller.dispatch({ type: 'expand' })
    expect(calls).toEqual([size('gmail'), 'mode:gmail', 'focus'])
    // The timer ending later changes nothing in the open panel.
    calls.length = 0
    vi.advanceTimersByTime(6000)
    expect(calls).toEqual([])
  })

  it('tells the renderer whether the alert it shows is the mail alert, before the mode', () => {
    const { controller, mailAlerts } = setup()
    controller.dispatch({ type: 'mail', on: true })
    expect(mailAlerts).toEqual([true])
    // A permission takes the alert capsule over: no longer the mail alert, mode stays `alert`.
    controller.dispatch({ type: 'attention', on: true })
    expect(controller.mode()).toBe('alert')
    expect(mailAlerts).toEqual([true, false])
    controller.dispatch({ type: 'attention', on: false })
    expect(mailAlerts).toEqual([true, false, true])
    vi.advanceTimersByTime(6000)
    expect(mailAlerts).toEqual([true, false, true, false])
  })

  it('never calls a reminder or permission alert a mail alert', () => {
    const { controller, mailAlerts } = setup()
    controller.dispatch({ type: 'reminders', due: true })
    controller.dispatch({ type: 'attention', on: true })
    controller.dispatch({ type: 'mail', on: true })
    expect(controller.mode()).toBe('alert')
    expect(mailAlerts).toEqual([])
  })

  it('sends the mail alert flag ahead of the mode change', () => {
    const order: string[] = []
    const surface: NotchSurface = {
      setBounds: () => {},
      show: () => {},
      hide: () => {},
      focus: () => {},
      blur: () => {},
      setIgnoreMouse: () => {},
      sendMode: (m) => order.push(`mode:${m}`),
      sendMailAlert: (on) => order.push(`mail:${on}`),
    }
    const controller = createNotchController({ surface, workArea, logger: createMemoryLogger() })
    controller.start()
    order.length = 0
    controller.dispatch({ type: 'mail', on: true })
    expect(order).toEqual(['mail:true', 'mode:alert'])
  })

  it('stops the timer on dispose', () => {
    const { controller, calls } = setup()
    controller.dispatch({ type: 'mail', on: true })
    controller.dispose()
    calls.length = 0
    vi.advanceTimersByTime(6000)
    expect(calls).toEqual([])
  })
})
