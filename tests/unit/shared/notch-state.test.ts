import { describe, expect, it } from 'vitest'
import { initialNotchState, notchMode, PANEL_MODES, reduceNotch, type NotchEvent, type NotchState } from '../../../src/shared/notch/state'

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

describe('attention (pending Claude permission)', () => {
  const attention = (on: boolean): NotchEvent => ({ type: 'attention', on })

  it('starts without attention', () => {
    expect(initialNotchState.attention).toBe(false)
  })

  it('shows the alert capsule when attention arrives on the compact capsule', () => {
    expect(notchMode(run(attention(true)))).toBe('alert')
    expect(notchMode(run(attention(true), attention(false)))).toBe('compact')
  })

  it('opens on the permission view when expanding with attention', () => {
    const state = run(attention(true), { type: 'expand' })
    expect(notchMode(state)).toBe('permission')
    expect(state).toMatchObject({ expanded: true, view: 'permission' })
    expect(notchMode(run(attention(true), { type: 'toggle' }))).toBe('permission')
  })

  it('opens on home when expanding without attention', () => {
    expect(run({ type: 'expand' }).view).toBe('home')
    expect(run({ type: 'toggle' }).view).toBe('home')
  })

  it('still opens the requested integration while attention is on', () => {
    const state = run(attention(true), { type: 'open-integration', id: 'terminal' })
    expect(notchMode(state)).toBe('terminal')
  })

  it('falls back from permission to home on back', () => {
    const state = run(attention(true), { type: 'expand' }, { type: 'back' })
    expect(state.view).toBe('home')
    expect(notchMode(state)).toBe('expanded')
  })

  it('returns the open permission view to home when attention ends, without closing the panel', () => {
    const state = run(attention(true), { type: 'expand' }, attention(false))
    expect(state).toMatchObject({ expanded: true, view: 'home' })
    expect(notchMode(state)).toBe('expanded')
  })

  it('does not open or collapse the panel by itself', () => {
    expect(run(attention(true)).expanded).toBe(false)
    expect(run({ type: 'expand' }, attention(true)).expanded).toBe(true)
    expect(notchMode(run({ type: 'expand' }, attention(true)))).toBe('expanded')
    expect(run({ type: 'expand' }, attention(true), attention(false)).expanded).toBe(true)
  })

  it('goes back to alert after dismiss while attention remains', () => {
    const state = run(attention(true), { type: 'expand' }, { type: 'dismiss' })
    expect(notchMode(state)).toBe('alert')
    expect(state.view).toBe('home')
    expect(notchMode(reduceNotch(state, { type: 'expand' }))).toBe('permission')
  })

  it('lets a hidden capsule win over the alert', () => {
    expect(notchMode(run(attention(true), { type: 'foreground', verdict: 'hidden' }))).toBe('hidden')
    expect(notchMode(run(attention(true), { type: 'user-visibility', hidden: true }))).toBe('hidden')
  })

  it('shows the alert on a mini capsule and over hover', () => {
    expect(notchMode(run(attention(true), { type: 'foreground', verdict: 'mini' }))).toBe('alert')
    expect(notchMode(run(attention(true), { type: 'pointer', inside: true }))).toBe('alert')
  })

  it('ignores repeated attention events', () => {
    const state = run(attention(true))
    expect(reduceNotch(state, attention(true))).toBe(state)
  })
})

describe('reminderDue (a reminder is due)', () => {
  const due = (on: boolean): NotchEvent => ({ type: 'reminders', due: on })
  const attention = (on: boolean): NotchEvent => ({ type: 'attention', on })

  it('starts without a due reminder', () => {
    expect(initialNotchState.reminderDue).toBe(false)
  })

  it('shows the alert capsule when a reminder is due on the compact capsule, and returns to compact when it is cleared', () => {
    expect(notchMode(run(due(true)))).toBe('alert')
    expect(notchMode(run(due(true), due(false)))).toBe('compact')
  })

  it('shows the alert capsule over mini and peek', () => {
    expect(notchMode(run(due(true), { type: 'foreground', verdict: 'mini' }))).toBe('alert')
    expect(notchMode(run(due(true), { type: 'pointer', inside: true }))).toBe('alert')
  })

  it('lets hidden win over the alert', () => {
    expect(notchMode(run(due(true), { type: 'foreground', verdict: 'hidden' }))).toBe('hidden')
    expect(notchMode(run(due(true), { type: 'user-visibility', hidden: true }))).toBe('hidden')
  })

  it('opens on the reminders view when expanding with a due reminder and no attention', () => {
    const state = run(due(true), { type: 'expand' })
    expect(state.view).toBe('reminders')
    expect(notchMode(state)).toBe('reminders')
    expect(notchMode(run(due(true), { type: 'toggle' }))).toBe('reminders')
  })

  it('prefers the permission card when both attention and a due reminder are pending', () => {
    const state = run(due(true), attention(true), { type: 'expand' })
    expect(state.view).toBe('permission')
    expect(notchMode(state)).toBe('permission')
  })

  it('opens on home when expanding with nothing pending', () => {
    expect(run({ type: 'expand' }).view).toBe('home')
  })

  it('opens the reminders integration explicitly', () => {
    expect(notchMode(run({ type: 'open-integration', id: 'reminders' }))).toBe('reminders')
  })

  it('never opens or closes the panel, and keeps the reminders view open when it is cleared', () => {
    expect(run(due(true)).expanded).toBe(false)
    const open = run(due(true), { type: 'expand' }, due(false))
    expect(open.expanded).toBe(true)
    expect(open.view).toBe('reminders')
    expect(notchMode(open)).toBe('reminders')
  })

  it('goes back to the alert after dismiss while a reminder remains due', () => {
    const state = run(due(true), { type: 'expand' }, { type: 'dismiss' })
    expect(state.view).toBe('home')
    expect(notchMode(state)).toBe('alert')
  })

  it('still lands on home for a permission view cleared by attention', () => {
    expect(run(attention(true), { type: 'expand' }, attention(false)).view).toBe('home')
  })

  it('opens the system integration and goes back to the integrations row', () => {
    const open = run({ type: 'open-integration', id: 'system' })
    expect(open).toMatchObject({ expanded: true, view: 'system' })
    expect(notchMode(open)).toBe('system')
    const back = reduceNotch(open, { type: 'back' })
    expect(back.view).toBe('home')
    expect(notchMode(back)).toBe('expanded')
  })

  it('treats system as a panel mode that dismisses to compact', () => {
    expect(PANEL_MODES.has('system')).toBe(true)
    expect(notchMode(run({ type: 'open-integration', id: 'system' }, { type: 'dismiss' }))).toBe('compact')
  })

  it('opens the notes integration, goes back to the integrations row, and dismisses to compact', () => {
    const open = run({ type: 'open-integration', id: 'notes' })
    expect(open).toMatchObject({ expanded: true, view: 'notes' })
    expect(notchMode(open)).toBe('notes')
    expect(PANEL_MODES.has('notes')).toBe(true)
    expect(notchMode(run({ type: 'open-integration', id: 'notes' }, { type: 'back' }))).toBe('expanded')
    expect(notchMode(run({ type: 'open-integration', id: 'notes' }, { type: 'dismiss' }))).toBe('compact')
  })

  it('ignores repeated reminders events', () => {
    const state = run(due(true))
    expect(reduceNotch(state, due(true))).toBe(state)
    expect(reduceNotch(initialNotchState, due(false))).toBe(initialNotchState)
  })
})
