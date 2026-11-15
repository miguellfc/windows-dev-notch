import { describe, expect, it } from 'vitest'
import { initialNotchState, isCapsuleHidden, notchMode, reduceNotch, type NotchEvent, type NotchState } from '../../../src/shared/notch/state'

const run = (...events: NotchEvent[]): NotchState => events.reduce(reduceNotch, initialNotchState)
const enter: NotchEvent = { type: 'pointer', inside: true }
const leave: NotchEvent = { type: 'pointer', inside: false }
const pin: NotchEvent = { type: 'pin-mini' }
const unpin: NotchEvent = { type: 'unpin-mini' }

/** The approved capsule-mode table: peek at rest, compact on hover, mini only by the user's right click. */
describe('capsule modes', () => {
  it('rests in peek (date and time only)', () => {
    expect(notchMode(initialNotchState)).toBe('peek')
    expect(initialNotchState.pinnedMini).toBe(false)
  })

  it('peek → compact when the pointer enters', () => {
    expect(notchMode(run(enter))).toBe('compact')
  })

  it('compact → peek when the pointer leaves', () => {
    expect(notchMode(run(enter, leave))).toBe('peek')
  })

  it('compact → main panel on left click', () => {
    expect(notchMode(run(enter, { type: 'expand' }))).toBe('expanded')
  })

  it('compact → mini on right click', () => {
    const state = run(enter, pin)
    expect(state.pinnedMini).toBe(true)
    expect(notchMode(state)).toBe('mini')
  })

  it('mini stays mini when the pointer enters or leaves', () => {
    expect(notchMode(run(enter, pin, leave))).toBe('mini')
    expect(notchMode(run(enter, pin, leave, enter))).toBe('mini')
  })

  it('mini → compact on left click: sticky until the pointer has entered compact and left it', () => {
    const clicked = run(enter, pin, leave, enter, unpin)
    expect(clicked.pinnedMini).toBe(false)
    expect(clicked.stickyCompact).toBe(true)
    expect(notchMode(clicked)).toBe('compact')
    // The pill sits above the compact capsule: the pointer is off it at once. That leave keeps compact.
    const off = reduceNotch(clicked, leave)
    expect(notchMode(off)).toBe('compact')
    // Entering compact ends the stickiness; leaving it then rests in peek.
    const inside = reduceNotch(off, enter)
    expect(inside.stickyCompact).toBe(false)
    expect(notchMode(inside)).toBe('compact')
    expect(notchMode(reduceNotch(inside, leave))).toBe('peek')
  })

  it('a sticky compact the pointer never enters rests in peek when it times out (main owns the timer)', () => {
    const off = run(pin, unpin, leave)
    expect(notchMode(off)).toBe('compact')
    const ended = reduceNotch(off, { type: 'sticky-end' })
    expect(ended.stickyCompact).toBe(false)
    expect(notchMode(ended)).toBe('peek')
    // With the pointer on compact when it times out, compact stays.
    expect(notchMode(run(pin, unpin, leave, enter, { type: 'sticky-end' }))).toBe('compact')
    // Nothing to end: same object.
    const peek = run()
    expect(reduceNotch(peek, { type: 'sticky-end' })).toBe(peek)
  })

  it('left click on mini shows compact even if the pointer report came late (it is on the pill)', () => {
    expect(notchMode(run(pin, unpin))).toBe('compact')
  })

  it('a panel, a new pin or hiding drops the stickiness', () => {
    expect(run(pin, unpin, { type: 'expand' }).stickyCompact).toBe(false)
    expect(notchMode(run(pin, unpin, leave, { type: 'expand' }, { type: 'dismiss' }))).toBe('peek')
    expect(run(pin, unpin, pin).stickyCompact).toBe(false)
    expect(run(pin, unpin, { type: 'user-visibility', hidden: true }).stickyCompact).toBe(false)
    expect(run(pin, unpin, { type: 'foreground', verdict: 'hidden' }).stickyCompact).toBe(false)
  })

  it('pin and unpin are no-ops when they change nothing', () => {
    const pinned = run(pin)
    expect(reduceNotch(pinned, pin)).toBe(pinned)
    const peek = run()
    expect(reduceNotch(peek, unpin)).toBe(peek)
  })

  it('right click never pins while a panel is open', () => {
    const open = run({ type: 'expand' })
    expect(reduceNotch(open, pin)).toBe(open)
  })

  it('right click never pins while the capsule is hidden or an alert shows', () => {
    for (const hidden of [run({ type: 'foreground', verdict: 'hidden' }), run({ type: 'user-visibility', hidden: true })]) {
      expect(reduceNotch(hidden, pin)).toBe(hidden)
    }
    for (const alert of [
      run({ type: 'attention', on: true }),
      run({ type: 'question', on: true }),
      run({ type: 'reminders', due: true }),
      run({ type: 'mail', on: true }),
      run({ type: 'review', on: true }),
      run({ type: 'foreground', verdict: 'hidden' }, { type: 'mail', on: true }),
    ]) {
      expect(reduceNotch(alert, pin)).toBe(alert)
    }
  })

  it('the panel (shortcut, tray) opens over mini and closes back to mini', () => {
    expect(notchMode(run(pin, { type: 'toggle' }))).toBe('expanded')
    expect(notchMode(run(pin, { type: 'toggle' }, { type: 'dismiss' }))).toBe('mini')
    expect(notchMode(run(pin, { type: 'show' }, { type: 'dismiss' }))).toBe('mini')
  })

  it.each<[string, NotchEvent, NotchEvent]>([
    ['permission', { type: 'attention', on: true }, { type: 'attention', on: false }],
    ['question', { type: 'question', on: true }, { type: 'question', on: false }],
    ['reminder', { type: 'reminders', due: true }, { type: 'reminders', due: false }],
    ['mail', { type: 'mail', on: true }, { type: 'mail', on: false }],
    ['review', { type: 'review', on: true }, { type: 'review', on: false }],
  ])('a %s alert shows over a pinned mini and returns to mini', (_name, on, off) => {
    expect(notchMode(run(pin, on))).toBe('alert')
    expect(notchMode(run(pin, on, off))).toBe('mini')
  })

  it('maximized windows no longer shrink the capsule: the only yield verdicts are none and hidden', () => {
    expect(notchMode(run({ type: 'foreground', verdict: 'none' }))).toBe('peek')
    expect(notchMode(run(enter, { type: 'foreground', verdict: 'none' }))).toBe('compact')
  })

  it('fullscreen still hides the capsule (also a pinned mini) and gives it back afterwards', () => {
    const fullscreen = run(pin, { type: 'foreground', verdict: 'hidden' })
    expect(notchMode(fullscreen)).toBe('hidden')
    expect(isCapsuleHidden(fullscreen)).toBe(true)
    expect(notchMode(reduceNotch(fullscreen, { type: 'foreground', verdict: 'none' }))).toBe('mini')
    expect(notchMode(run({ type: 'foreground', verdict: 'hidden' }, { type: 'foreground', verdict: 'none' }))).toBe('peek')
  })

  it('"Ocultar" hides a pinned mini; showing again keeps it pinned', () => {
    const hidden = run(pin, { type: 'user-visibility', hidden: true })
    expect(notchMode(hidden)).toBe('hidden')
    expect(notchMode(reduceNotch(hidden, { type: 'user-visibility', hidden: false }))).toBe('mini')
  })
})
