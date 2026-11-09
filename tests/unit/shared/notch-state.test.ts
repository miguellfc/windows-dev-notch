import { describe, expect, it } from 'vitest'
import { initialNotchState, notchMode, reduceNotch, type NotchEvent, type NotchState } from '../../../src/shared/notch/state'

const run = (...events: NotchEvent[]): NotchState => events.reduce(reduceNotch, initialNotchState)

describe('notch state machine', () => {
  it('starts compact', () => {
    expect(notchMode(initialNotchState)).toBe('compact')
  })

  it('peeks while the pointer is over the capsule', () => {
    expect(notchMode(run({ type: 'pointer', inside: true }))).toBe('peek')
    expect(notchMode(run({ type: 'pointer', inside: true }, { type: 'pointer', inside: false }))).toBe('compact')
  })

  it('expands on click or shortcut and dismisses back', () => {
    expect(notchMode(run({ type: 'expand' }))).toBe('expanded')
    expect(notchMode(run({ type: 'toggle' }))).toBe('expanded')
    expect(notchMode(run({ type: 'toggle' }, { type: 'toggle' }))).toBe('compact')
    expect(notchMode(run({ type: 'expand' }, { type: 'dismiss' }))).toBe('compact')
  })

  it('yields to maximized and fullscreen windows', () => {
    expect(notchMode(run({ type: 'foreground', verdict: 'mini' }))).toBe('mini')
    expect(notchMode(run({ type: 'foreground', verdict: 'hidden' }))).toBe('hidden')
    expect(notchMode(run({ type: 'foreground', verdict: 'mini' }, { type: 'foreground', verdict: 'none' }))).toBe('compact')
  })

  it('grows from mini to peek when the pointer approaches', () => {
    expect(notchMode(run({ type: 'foreground', verdict: 'mini' }, { type: 'pointer', inside: true }))).toBe('peek')
  })

  it('lets explicit user intent win over yielding', () => {
    expect(notchMode(run({ type: 'foreground', verdict: 'hidden' }, { type: 'toggle' }))).toBe('expanded')
    expect(notchMode(run({ type: 'foreground', verdict: 'hidden' }, { type: 'toggle' }, { type: 'dismiss' }))).toBe('hidden')
  })

  it('hides on user request and shows again', () => {
    const hidden = run({ type: 'expand' }, { type: 'user-visibility', hidden: true })
    expect(notchMode(hidden)).toBe('hidden')
    expect(notchMode(reduceNotch(hidden, { type: 'user-visibility', hidden: false }))).toBe('compact')
  })

  it('un-hides when the user explicitly expands', () => {
    expect(notchMode(run({ type: 'user-visibility', hidden: true }, { type: 'toggle' }))).toBe('expanded')
  })

  it('forgets the pointer when the capsule disappears (no pointerleave ever fires)', () => {
    const hidden = run({ type: 'expand' }, { type: 'pointer', inside: true }, { type: 'user-visibility', hidden: true })
    expect(hidden.pointerInside).toBe(false)
    expect(notchMode(reduceNotch(hidden, { type: 'user-visibility', hidden: false }))).toBe('compact')

    const yielded = run({ type: 'pointer', inside: true }, { type: 'foreground', verdict: 'hidden' })
    expect(yielded.pointerInside).toBe(false)
  })

  it('returns the very same object when an event changes nothing (M0: repeated dismiss)', () => {
    const expanded = run({ type: 'expand' })
    const dismissed = reduceNotch(expanded, { type: 'dismiss' })
    expect(reduceNotch(dismissed, { type: 'dismiss' })).toBe(dismissed)
    expect(reduceNotch(initialNotchState, { type: 'pointer', inside: false })).toBe(initialNotchState)
    expect(reduceNotch(expanded, { type: 'expand' })).toBe(expanded)
  })

  describe('terminal view', () => {
    const terminal = () => run({ type: 'open-integration', id: 'terminal' })

    it('opens the terminal integration as its own expanded mode', () => {
      const state = terminal()
      expect(notchMode(state)).toBe('terminal')
      expect(state).toMatchObject({ expanded: true, view: 'terminal', userHidden: false })
      expect(notchMode(run({ type: 'user-visibility', hidden: true }, { type: 'open-integration', id: 'terminal' }))).toBe('terminal')
    })

    it('goes back to the integrations row without closing the panel', () => {
      const state = reduceNotch(terminal(), { type: 'back' })
      expect(notchMode(state)).toBe('expanded')
      expect(state.view).toBe('home')
    })

    it('always reopens on the integrations row after closing from the terminal', () => {
      const dismissed = reduceNotch(terminal(), { type: 'dismiss' })
      expect(notchMode(dismissed)).toBe('compact')
      expect(dismissed.view).toBe('home')
      expect(notchMode(reduceNotch(dismissed, { type: 'expand' }))).toBe('expanded')

      const toggled = reduceNotch(terminal(), { type: 'toggle' })
      expect(notchMode(toggled)).toBe('compact')
      expect(toggled.view).toBe('home')

      const hidden = reduceNotch(terminal(), { type: 'user-visibility', hidden: true })
      expect(notchMode(hidden)).toBe('hidden')
      expect(hidden.view).toBe('home')
    })

    it('ignores back when there is no panel', () => {
      expect(reduceNotch(initialNotchState, { type: 'back' })).toBe(initialNotchState)
      expect(initialNotchState.view).toBe('home')
    })
  })
})
