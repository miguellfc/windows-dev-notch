import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNotchController, MAIL_ALERT_MS, REVIEW_ALERT_MS, STICKY_COMPACT_MS, type NotchSurface } from '../../../src/main/windows/notch-controller'
import { windowBoundsFor } from '../../../src/shared/notch/geometry'
import { createMemoryLogger } from '../helpers/memory-logger'

const workArea = { x: 0, y: 0, width: 1920, height: 1032 }

function setup() {
  const calls: string[] = []
  const mailAlerts: boolean[] = []
  const reviewAlerts: boolean[] = []
  const surface: NotchSurface = {
    setBounds: (rect) => calls.push(`bounds:${rect.width}x${rect.height}`),
    show: () => calls.push('show'),
    hide: () => calls.push('hide'),
    focus: () => calls.push('focus'),
    blur: () => calls.push('blur'),
    setIgnoreMouse: (ignore) => calls.push(`ignore:${ignore}`),
    sendMode: (mode) => calls.push(`mode:${mode}`),
    sendMailAlert: (on) => mailAlerts.push(on),
    sendReviewAlert: (on) => reviewAlerts.push(on),
  }
  const onModeChange = vi.fn()
  const controller = createNotchController({ surface, workArea, settleTimeoutMs: 400, logger: createMemoryLogger(), onModeChange })
  controller.start()
  calls.length = 0
  mailAlerts.length = 0
  reviewAlerts.length = 0
  return { controller, calls, mailAlerts, reviewAlerts, onModeChange }
}

const size = (mode: Parameters<typeof windowBoundsFor>[0]) => {
  const b = windowBoundsFor(mode, workArea)
  return `bounds:${b.width}x${b.height}`
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('notch controller', () => {
  it('starts in peek, visible and click-through', () => {
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
      sendReviewAlert: () => {},
    }
    createNotchController({ surface, workArea, logger: createMemoryLogger() }).start()
    expect(calls).toEqual([size('peek'), 'ignore:true', 'mode:peek', 'show'])
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
      sendReviewAlert: () => {},
    }
    const controller = createNotchController({ surface, workArea, logger: createMemoryLogger() })
    controller.dispatch({ type: 'foreground', verdict: 'hidden' })
    expect(calls).toEqual([])
    controller.start()
    expect(calls).toEqual(['ignore:true', 'mode:hidden', 'hide'])

    calls.length = 0
    const other = createNotchController({ surface, workArea, logger: createMemoryLogger() })
    other.dispatch({ type: 'pin-mini' })
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
    expect(calls).toEqual(['mode:peek', 'blur'])
    controller.settled()
    expect(calls).toEqual(['mode:peek', 'blur', size('peek')])
  })

  it('shrinks anyway after a timeout if the renderer never settles', () => {
    const { controller, calls } = setup()
    controller.dispatch({ type: 'expand' })
    controller.dispatch({ type: 'dismiss' })
    calls.length = 0
    vi.advanceTimersByTime(400)
    expect(calls).toEqual([size('peek')])
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
    controller.dispatch({ type: 'foreground', verdict: 'none' })
    expect(calls).toEqual([size('peek'), 'mode:peek', 'show'])
  })

  it('repositions on a new work area', () => {
    const { controller, calls } = setup()
    controller.setWorkArea({ x: 1920, y: 0, width: 2560, height: 1400 })
    expect(calls).toEqual([size('peek')])
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
    expect(calls).toEqual(['mode:compact', 'ignore:false'])
    controller.settled()
    expect(calls.at(-1)).toBe(size('compact'))
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
      expect(calls).toEqual(['mode:peek', 'blur'])
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
    expect(calls).toEqual(['mode:peek', 'blur'])
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
  it('grows into the alert capsule without taking focus and goes back to peek after 6 s', () => {
    const { controller, calls } = setup()
    controller.dispatch({ type: 'mail', on: true })
    expect(calls).toEqual([size('alert'), 'mode:alert'])
    expect(MAIL_ALERT_MS).toBe(6000)
    vi.advanceTimersByTime(5999)
    expect(controller.mode()).toBe('alert')
    vi.advanceTimersByTime(1)
    expect(controller.mode()).toBe('peek')
  })

  it('restarts the 6 s when more mail arrives while it shows', () => {
    const { controller } = setup()
    controller.dispatch({ type: 'mail', on: true })
    vi.advanceTimersByTime(4000)
    controller.dispatch({ type: 'mail', on: true })
    vi.advanceTimersByTime(4000)
    expect(controller.mode()).toBe('alert')
    vi.advanceTimersByTime(2000)
    expect(controller.mode()).toBe('peek')
  })

  it('is ignored while a panel is open, and does not show after it closes', () => {
    const { controller, calls } = setup()
    controller.dispatch({ type: 'open-integration', id: 'notes' })
    calls.length = 0
    controller.dispatch({ type: 'mail', on: true })
    expect(calls).toEqual([])
    controller.dispatch({ type: 'dismiss' })
    expect(controller.mode()).toBe('peek')
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
      sendReviewAlert: (on) => order.push(`review:${on}`),
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

describe('notch controller: alerts over a hidden capsule', () => {
  const hiddenSetup = (hide: 'user' | 'yield') => {
    const t = setup()
    t.controller.dispatch(hide === 'user' ? { type: 'user-visibility', hidden: true } : { type: 'foreground', verdict: 'hidden' })
    expect(t.controller.mode()).toBe('hidden')
    t.calls.length = 0
    return t
  }

  for (const hide of ['user', 'yield'] as const) {
    it(`shows the window without focus for a permission and hides it again when answered (${hide})`, () => {
      const { controller, calls } = hiddenSetup(hide)
      controller.dispatch({ type: 'attention', on: true })
      expect(controller.mode()).toBe('alert')
      expect(calls).toEqual([size('alert'), 'mode:alert', 'show'])
      calls.length = 0
      controller.dispatch({ type: 'attention', on: false })
      expect(controller.mode()).toBe('hidden')
      expect(calls).toEqual(['mode:hidden', 'hide', 'ignore:true'])
    })
  }

  it('shows a due reminder over the hidden capsule and hides again when it is cleared', () => {
    const { controller, calls } = hiddenSetup('user')
    controller.dispatch({ type: 'reminders', due: true })
    expect(calls).toEqual([size('alert'), 'mode:alert', 'show'])
    expect(calls).not.toContain('focus')
    calls.length = 0
    controller.dispatch({ type: 'reminders', due: false })
    expect(calls).toEqual(['mode:hidden', 'hide', 'ignore:true'])
  })

  it('shows the mail alert over the hidden capsule for 6 s, then hides the window again', () => {
    const { controller, calls, mailAlerts } = hiddenSetup('yield')
    controller.dispatch({ type: 'mail', on: true })
    expect(mailAlerts).toEqual([true])
    expect(calls).toEqual([size('alert'), 'mode:alert', 'show'])
    calls.length = 0
    vi.advanceTimersByTime(5999)
    expect(controller.mode()).toBe('alert')
    vi.advanceTimersByTime(1)
    expect(controller.mode()).toBe('hidden')
    expect(calls).toEqual(['mode:hidden', 'hide', 'ignore:true'])
    expect(mailAlerts).toEqual([true, false])
  })

  it('a repeated yield verdict while the alert shows does not hide it', () => {
    const { controller, calls } = hiddenSetup('yield')
    controller.dispatch({ type: 'attention', on: true })
    calls.length = 0
    controller.dispatch({ type: 'foreground', verdict: 'hidden' })
    controller.dispatch({ type: 'foreground', verdict: 'none' })
    controller.dispatch({ type: 'foreground', verdict: 'hidden' })
    expect(controller.mode()).toBe('alert')
    expect(calls).not.toContain('hide')
  })

  it('opens the panel from the alert and goes back to hidden when it closes', () => {
    const { controller, calls } = hiddenSetup('user')
    controller.dispatch({ type: 'attention', on: true })
    controller.dispatch({ type: 'expand' })
    expect(controller.mode()).toBe('permission')
    expect(calls).toContain('focus')
    controller.dispatch({ type: 'attention', on: false })
    calls.length = 0
    controller.dispatch({ type: 'dismiss' })
    expect(controller.mode()).toBe('hidden')
    expect(calls).toEqual(['mode:hidden', 'hide', 'ignore:true', 'blur'])
  })

  it('show (tray icon or "Mostrar") from the alert un-hides: closing the panel leaves the capsule on screen', () => {
    const { controller } = hiddenSetup('user')
    controller.dispatch({ type: 'attention', on: true })
    controller.dispatch({ type: 'show' })
    expect(controller.mode()).toBe('permission')
    expect(controller.hidden()).toBe(false)
    controller.dispatch({ type: 'attention', on: false })
    controller.dispatch({ type: 'dismiss' })
    expect(controller.mode()).toBe('peek')
  })

  it('reports whether the capsule is hidden apart from alerts, and when that changes', () => {
    const onHiddenChange = vi.fn()
    const surface: NotchSurface = {
      setBounds: () => {},
      show: () => {},
      hide: () => {},
      focus: () => {},
      blur: () => {},
      setIgnoreMouse: () => {},
      sendMode: () => {},
      sendMailAlert: () => {},
      sendReviewAlert: () => {},
    }
    const controller = createNotchController({ surface, workArea, logger: createMemoryLogger(), onHiddenChange })
    controller.start()
    expect(controller.hidden()).toBe(false)
    controller.dispatch({ type: 'attention', on: true })
    controller.dispatch({ type: 'user-visibility', hidden: true })
    // Still showing the alert, yet hidden as far as the tray is concerned.
    expect(controller.mode()).toBe('alert')
    expect(controller.hidden()).toBe(true)
    expect(onHiddenChange).toHaveBeenLastCalledWith(true)
    controller.dispatch({ type: 'user-visibility', hidden: false })
    expect(controller.hidden()).toBe(false)
    expect(onHiddenChange).toHaveBeenCalledTimes(2)
  })
})

describe('notch controller: Claude question', () => {
  it('grows into the alert capsule without taking focus, also from mini', () => {
    const { controller, calls } = setup()
    controller.dispatch({ type: 'pin-mini' })
    calls.length = 0
    controller.dispatch({ type: 'question', on: true })
    expect(calls).toEqual([size('alert'), 'mode:alert'])
  })

  it('opens the question card with focus, and closes once the card is done with the last item', () => {
    const { controller, calls } = setup()
    controller.dispatch({ type: 'question', on: true })
    calls.length = 0
    controller.dispatch({ type: 'expand' })
    expect(calls).toEqual([size('question'), 'mode:question', 'focus'])
    calls.length = 0
    // Answered: the card stays to say so, then asks for the next item.
    controller.dispatch({ type: 'question', on: false })
    expect(controller.mode()).toBe('question')
    controller.dispatch({ type: 'next' })
    expect(controller.mode()).toBe('peek')
    expect(calls).toEqual(['mode:peek', 'blur'])
  })

  it('opens the earliest of a permission and a question, then the other one', () => {
    const { controller } = setup()
    controller.dispatch({ type: 'claude-first', kind: 'question' })
    controller.dispatch({ type: 'question', on: true })
    controller.dispatch({ type: 'claude-first', kind: 'question' })
    controller.dispatch({ type: 'attention', on: true })
    controller.dispatch({ type: 'expand' })
    expect(controller.mode()).toBe('question')
    controller.dispatch({ type: 'claude-first', kind: 'permission' })
    controller.dispatch({ type: 'question', on: false })
    controller.dispatch({ type: 'next' })
    expect(controller.mode()).toBe('permission')
    controller.dispatch({ type: 'attention', on: false })
    expect(controller.mode()).toBe('expanded')
  })

  it('never shows the new-mail alert while a question waits', () => {
    const { controller, mailAlerts } = setup()
    controller.dispatch({ type: 'question', on: true })
    controller.dispatch({ type: 'mail', on: true })
    expect(controller.mode()).toBe('alert')
    expect(mailAlerts).toEqual([])
  })
})

describe('notch controller: first-review alert', () => {
  it('shows the review alert for 6 s and tells the renderer before the mode', () => {
    const { controller, reviewAlerts, mailAlerts } = setup()
    expect(REVIEW_ALERT_MS).toBe(6000)
    controller.dispatch({ type: 'review', on: true })
    expect(controller.mode()).toBe('alert')
    expect(reviewAlerts).toEqual([true])
    expect(mailAlerts).toEqual([])
    vi.advanceTimersByTime(5999)
    expect(controller.mode()).toBe('alert')
    vi.advanceTimersByTime(1)
    expect(controller.mode()).toBe('peek')
    expect(reviewAlerts).toEqual([true, false])
  })

  it('is ignored with a panel open, like mail', () => {
    const { controller, reviewAlerts } = setup()
    controller.dispatch({ type: 'expand' })
    controller.dispatch({ type: 'review', on: true })
    expect(controller.mode()).toBe('expanded')
    expect(reviewAlerts).toEqual([])
  })

  it('the newer of mail and review shows, with its own full 6 s', () => {
    const { controller, reviewAlerts, mailAlerts } = setup()
    controller.dispatch({ type: 'mail', on: true })
    vi.advanceTimersByTime(4000)
    controller.dispatch({ type: 'review', on: true })
    expect(mailAlerts).toEqual([true, false])
    expect(reviewAlerts).toEqual([true])
    // The mail timer ending does not cut the review alert short.
    vi.advanceTimersByTime(2000)
    expect(controller.mode()).toBe('alert')
    vi.advanceTimersByTime(4000)
    expect(controller.mode()).toBe('peek')
    expect(reviewAlerts).toEqual([true, false])
  })

  it('shows over a hidden capsule and hides again', () => {
    const { controller, calls } = setup()
    controller.dispatch({ type: 'user-visibility', hidden: true })
    calls.length = 0
    controller.dispatch({ type: 'review', on: true })
    expect(calls).toEqual([size('alert'), 'mode:alert', 'show'])
    vi.advanceTimersByTime(6000)
    expect(controller.mode()).toBe('hidden')
  })

  it('opens the reviews view when expanding from the review alert', () => {
    const { controller } = setup()
    controller.dispatch({ type: 'review', on: true })
    controller.dispatch({ type: 'expand' })
    expect(controller.mode()).toBe('reviews')
  })
})

describe('notch controller: capsule modes (peek, compact, pinned mini)', () => {
  const at = (mode: Parameters<typeof windowBoundsFor>[0]) => windowBoundsFor(mode, workArea)

  function placed() {
    const rects: { x: number; y: number; width: number; height: number }[] = []
    const ignores: boolean[] = []
    const modes: string[] = []
    const surface: NotchSurface = {
      setBounds: (rect) => rects.push(rect),
      show: () => {},
      hide: () => {},
      focus: () => {},
      blur: () => {},
      setIgnoreMouse: (ignore) => ignores.push(ignore),
      sendMode: (mode) => modes.push(mode),
      sendMailAlert: () => {},
      sendReviewAlert: () => {},
    }
    const controller = createNotchController({ surface, workArea, settleTimeoutMs: 400, logger: createMemoryLogger() })
    controller.start()
    return { controller, rects, ignores, modes }
  }

  it('starts sized for peek at the top of the work area', () => {
    const { rects, modes } = placed()
    expect(rects).toEqual([at('peek')])
    expect(modes).toEqual(['peek'])
  })

  it('hovering peek shows compact without resizing the window (same height), and leaving goes back', () => {
    const { controller, rects, modes } = placed()
    rects.length = 0
    controller.dispatch({ type: 'pointer', inside: true })
    expect(controller.mode()).toBe('compact')
    controller.dispatch({ type: 'pointer', inside: false })
    vi.advanceTimersByTime(400)
    expect(controller.mode()).toBe('peek')
    expect(modes.slice(1)).toEqual(['compact', 'peek'])
    expect(new Set(rects.map((r) => r.height))).toEqual(new Set([at('peek').height]))
  })

  it('right click pins mini: animates first, then shrinks to a window whose top is the screen edge', () => {
    const { controller, rects } = placed()
    controller.dispatch({ type: 'pointer', inside: true })
    rects.length = 0
    controller.dispatch({ type: 'pin-mini' })
    expect(controller.mode()).toBe('mini')
    expect(rects).toEqual([])
    controller.settled()
    expect(rects).toEqual([at('mini')])
    expect(rects[0]?.y).toBe(workArea.y)
  })

  it('in mini only the pill takes the mouse: click-through until the pointer is on it', () => {
    const { controller, ignores } = placed()
    controller.dispatch({ type: 'pointer', inside: true })
    controller.dispatch({ type: 'pin-mini' })
    controller.dispatch({ type: 'pointer', inside: false })
    expect(ignores.at(-1)).toBe(true)
    controller.dispatch({ type: 'pointer', inside: true })
    expect(controller.mode()).toBe('mini')
    expect(ignores.at(-1)).toBe(false)
    controller.dispatch({ type: 'pointer', inside: false })
    expect(ignores.at(-1)).toBe(true)
  })

  it('left click on mini grows back to compact, which sticks until the pointer has been on it', () => {
    const { controller, rects } = placed()
    controller.dispatch({ type: 'pointer', inside: true })
    controller.dispatch({ type: 'pin-mini' })
    controller.settled()
    rects.length = 0
    controller.dispatch({ type: 'unpin-mini' })
    expect(controller.mode()).toBe('compact')
    expect(rects).toEqual([at('compact')])
    // The pill is above compact: the pointer is off it at once, and compact stays.
    controller.dispatch({ type: 'pointer', inside: false })
    expect(controller.mode()).toBe('compact')
    controller.dispatch({ type: 'pointer', inside: true })
    controller.dispatch({ type: 'pointer', inside: false })
    expect(controller.mode()).toBe('peek')
    // The entered pointer cancelled the timer: nothing fires later.
    vi.advanceTimersByTime(STICKY_COMPACT_MS)
    expect(controller.mode()).toBe('peek')
  })

  it('a sticky compact the pointer never enters rests in peek after STICKY_COMPACT_MS', () => {
    const { controller } = placed()
    controller.dispatch({ type: 'pin-mini' })
    controller.dispatch({ type: 'unpin-mini' })
    controller.dispatch({ type: 'pointer', inside: false })
    vi.advanceTimersByTime(STICKY_COMPACT_MS - 1)
    expect(controller.mode()).toBe('compact')
    vi.advanceTimersByTime(1)
    expect(controller.mode()).toBe('peek')
  })

  it('dispose stops the sticky timer', () => {
    const { controller } = placed()
    controller.dispatch({ type: 'pin-mini' })
    controller.dispatch({ type: 'unpin-mini' })
    controller.dispose()
    vi.advanceTimersByTime(STICKY_COMPACT_MS)
    expect(controller.mode()).toBe('compact')
  })

  it('an alert grows out of mini and goes back to mini when it ends', () => {
    const { controller, rects } = placed()
    controller.dispatch({ type: 'pin-mini' })
    controller.settled()
    rects.length = 0
    controller.dispatch({ type: 'mail', on: true })
    expect(rects).toEqual([at('alert')])
    vi.advanceTimersByTime(MAIL_ALERT_MS)
    expect(controller.mode()).toBe('mini')
    controller.settled()
    expect(rects.at(-1)).toEqual(at('mini'))
  })

  it('a maximized window cannot shrink the capsule any more; fullscreen still hides it', () => {
    const { controller } = placed()
    controller.dispatch({ type: 'foreground', verdict: 'none' })
    expect(controller.mode()).toBe('peek')
    controller.dispatch({ type: 'foreground', verdict: 'hidden' })
    expect(controller.mode()).toBe('hidden')
  })
})
