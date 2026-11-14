import { describe, expect, it } from 'vitest'
import { initialNotchState, isCapsuleHidden, mailAlertShown, notchMode, reviewAlertShown, PANEL_MODES, reduceNotch, type NotchEvent, type NotchState } from '../../../src/shared/notch/state'

const run = (...events: NotchEvent[]): NotchState => events.reduce(reduceNotch, initialNotchState)

describe('notch state machine', () => {
  it('starts in peek (time and date)', () => {
    expect(notchMode(initialNotchState)).toBe('peek')
  })

  it('shows the compact capsule while the pointer is over it', () => {
    expect(notchMode(run({ type: 'pointer', inside: true }))).toBe('compact')
    expect(notchMode(run({ type: 'pointer', inside: true }, { type: 'pointer', inside: false }))).toBe('peek')
  })

  it('expands on click or shortcut and dismisses back', () => {
    expect(notchMode(run({ type: 'expand' }))).toBe('expanded')
    expect(notchMode(run({ type: 'toggle' }))).toBe('expanded')
    expect(notchMode(run({ type: 'toggle' }, { type: 'toggle' }))).toBe('peek')
    expect(notchMode(run({ type: 'expand' }, { type: 'dismiss' }))).toBe('peek')
  })

  it('yields to fullscreen windows only', () => {
    expect(notchMode(run({ type: 'foreground', verdict: 'hidden' }))).toBe('hidden')
    expect(notchMode(run({ type: 'foreground', verdict: 'hidden' }, { type: 'foreground', verdict: 'none' }))).toBe('peek')
  })

  it('keeps a pinned mini when the pointer approaches', () => {
    expect(notchMode(run({ type: 'pin-mini' }, { type: 'pointer', inside: true }))).toBe('mini')
  })

  it('lets explicit user intent win over yielding', () => {
    expect(notchMode(run({ type: 'foreground', verdict: 'hidden' }, { type: 'toggle' }))).toBe('expanded')
    expect(notchMode(run({ type: 'foreground', verdict: 'hidden' }, { type: 'toggle' }, { type: 'dismiss' }))).toBe('hidden')
  })

  it('hides on user request and shows again', () => {
    const hidden = run({ type: 'expand' }, { type: 'user-visibility', hidden: true })
    expect(notchMode(hidden)).toBe('hidden')
    expect(notchMode(reduceNotch(hidden, { type: 'user-visibility', hidden: false }))).toBe('peek')
  })

  it('un-hides when the user explicitly expands', () => {
    expect(notchMode(run({ type: 'user-visibility', hidden: true }, { type: 'toggle' }))).toBe('expanded')
  })

  it('forgets the pointer when the capsule disappears (no pointerleave ever fires)', () => {
    const hidden = run({ type: 'expand' }, { type: 'pointer', inside: true }, { type: 'user-visibility', hidden: true })
    expect(hidden.pointerInside).toBe(false)
    expect(notchMode(reduceNotch(hidden, { type: 'user-visibility', hidden: false }))).toBe('peek')

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
      expect(notchMode(dismissed)).toBe('peek')
      expect(dismissed.view).toBe('home')
      expect(notchMode(reduceNotch(dismissed, { type: 'expand' }))).toBe('expanded')

      const toggled = reduceNotch(terminal(), { type: 'toggle' })
      expect(notchMode(toggled)).toBe('peek')
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
    expect(notchMode(run(attention(true), attention(false)))).toBe('peek')
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

  it('shows the alert over a hidden capsule (yielding or hidden by the user) and hides again when it ends', () => {
    const yielded = run({ type: 'foreground', verdict: 'hidden' }, attention(true))
    expect(notchMode(yielded)).toBe('alert')
    expect(notchMode(run(attention(true), { type: 'foreground', verdict: 'hidden' }))).toBe('alert')
    expect(notchMode(run(attention(true), { type: 'user-visibility', hidden: true }))).toBe('alert')
    expect(notchMode(reduceNotch(yielded, attention(false)))).toBe('hidden')
    expect(notchMode(run({ type: 'user-visibility', hidden: true }, attention(true), attention(false)))).toBe('hidden')
    // The alert leaves the hiding flags as they were.
    expect(yielded).toMatchObject({ yielding: 'hidden', userHidden: false })
    expect(run({ type: 'user-visibility', hidden: true }, attention(true)).userHidden).toBe(true)
  })

  it('returns to mini when the alert ends on a mini capsule', () => {
    expect(notchMode(run({ type: 'pin-mini' }, attention(true), attention(false)))).toBe('mini')
  })

  it('opens the panel from an alert over a hidden capsule and goes back to hidden when it closes', () => {
    const hides: NotchEvent[] = [
      { type: 'foreground', verdict: 'hidden' },
      { type: 'user-visibility', hidden: true },
    ]
    for (const hide of hides) {
      const open = run(hide, attention(true), { type: 'expand' })
      expect(notchMode(open)).toBe('permission')
      // Still pending: back to the alert; answered: back to hidden.
      expect(notchMode(reduceNotch(open, { type: 'dismiss' }))).toBe('alert')
      expect(notchMode(run(hide, attention(true), { type: 'expand' }, attention(false), { type: 'dismiss' }))).toBe('hidden')
      expect(notchMode(run(hide, attention(true), { type: 'toggle' }, attention(false), { type: 'toggle' }))).toBe('hidden')
    }
  })

  it('moving between views of a panel opened from the alert keeps it hidden on close', () => {
    const state = run(
      { type: 'user-visibility', hidden: true },
      attention(true),
      { type: 'expand' },
      attention(false),
      { type: 'open-integration', id: 'reminders' },
      { type: 'back' },
      { type: 'open-integration', id: 'notes' },
      { type: 'dismiss' },
    )
    expect(notchMode(state)).toBe('hidden')
  })

  it('un-hiding first (the tray "Show") keeps the capsule shown after the panel from the alert closes', () => {
    const state = run(
      { type: 'user-visibility', hidden: true },
      attention(true),
      { type: 'user-visibility', hidden: false },
      { type: 'expand' },
      attention(false),
      { type: 'dismiss' },
    )
    expect(notchMode(state)).toBe('peek')
  })

  it('show (the tray icon and its "Mostrar") opens the panel and un-hides, even from an alert over a hidden capsule', () => {
    const fromAlert = run({ type: 'user-visibility', hidden: true }, attention(true), { type: 'show' })
    expect(notchMode(fromAlert)).toBe('permission')
    expect(fromAlert.userHidden).toBe(false)
    expect(notchMode(reduceNotch(reduceNotch(fromAlert, attention(false)), { type: 'dismiss' }))).toBe('peek')
    const fromHidden = run({ type: 'user-visibility', hidden: true }, { type: 'show' })
    expect(notchMode(fromHidden)).toBe('expanded')
    expect(notchMode(reduceNotch(fromHidden, { type: 'dismiss' }))).toBe('peek')
    // Yielding to a fullscreen window is not the user's to undo: it opens, and closes back to hidden.
    expect(notchMode(run({ type: 'foreground', verdict: 'hidden' }, { type: 'show' }, { type: 'dismiss' }))).toBe('hidden')
    // On a visible capsule it is a plain expand; with a panel open it changes nothing.
    expect(notchMode(run({ type: 'show' }))).toBe('expanded')
    const open = run({ type: 'open-integration', id: 'notes' })
    expect(reduceNotch(open, { type: 'show' })).toBe(open)
  })

  it('forgets the pointer once an alert over a hidden capsule ends', () => {
    const state = run({ type: 'user-visibility', hidden: true }, attention(true), { type: 'pointer', inside: true })
    expect(notchMode(state)).toBe('alert')
    expect(state.pointerInside).toBe(true)
    const after = reduceNotch(state, attention(false))
    expect(notchMode(after)).toBe('hidden')
    expect(after.pointerInside).toBe(false)
  })

  it('shows the alert on a mini capsule and over hover', () => {
    expect(notchMode(run(attention(true), { type: 'pin-mini' }))).toBe('alert')
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
    expect(notchMode(run(due(true), due(false)))).toBe('peek')
  })

  it('shows the alert capsule over mini and peek', () => {
    expect(notchMode(run(due(true), { type: 'pin-mini' }))).toBe('alert')
    expect(notchMode(run(due(true), { type: 'pointer', inside: true }))).toBe('alert')
  })

  it('shows the alert over a hidden capsule and hides again when it is cleared', () => {
    expect(notchMode(run(due(true), { type: 'foreground', verdict: 'hidden' }))).toBe('alert')
    expect(notchMode(run({ type: 'user-visibility', hidden: true }, due(true)))).toBe('alert')
    expect(notchMode(run({ type: 'user-visibility', hidden: true }, due(true), due(false)))).toBe('hidden')
    expect(notchMode(run({ type: 'foreground', verdict: 'hidden' }, due(true), due(false)))).toBe('hidden')
    expect(notchMode(run({ type: 'pin-mini' }, due(true), due(false)))).toBe('mini')
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
    expect(notchMode(run({ type: 'open-integration', id: 'system' }, { type: 'dismiss' }))).toBe('peek')
  })

  it('opens the notes integration, goes back to the integrations row, and dismisses to compact', () => {
    const open = run({ type: 'open-integration', id: 'notes' })
    expect(open).toMatchObject({ expanded: true, view: 'notes' })
    expect(notchMode(open)).toBe('notes')
    expect(PANEL_MODES.has('notes')).toBe(true)
    expect(notchMode(run({ type: 'open-integration', id: 'notes' }, { type: 'back' }))).toBe('expanded')
    expect(notchMode(run({ type: 'open-integration', id: 'notes' }, { type: 'dismiss' }))).toBe('peek')
  })

  it('opens the gmail integration, goes back to the integrations row, and dismisses to compact', () => {
    const open = run({ type: 'open-integration', id: 'gmail' })
    expect(open).toMatchObject({ expanded: true, view: 'gmail' })
    expect(notchMode(open)).toBe('gmail')
    expect(PANEL_MODES.has('gmail')).toBe(true)
    expect(notchMode(run({ type: 'open-integration', id: 'gmail' }, { type: 'back' }))).toBe('expanded')
    expect(notchMode(run({ type: 'open-integration', id: 'gmail' }, { type: 'dismiss' }))).toBe('peek')
  })

  it('ignores repeated reminders events', () => {
    const state = run(due(true))
    expect(reduceNotch(state, due(true))).toBe(state)
    expect(reduceNotch(initialNotchState, due(false))).toBe(initialNotchState)
  })
})

describe('mailAlert (new mail, the lowest-priority alert)', () => {
  const mail = (on: boolean): NotchEvent => ({ type: 'mail', on })

  it('starts without a mail alert', () => {
    expect(initialNotchState.mailAlert).toBe(false)
  })

  it('shows the alert capsule from compact (and over the mini pill and hover) and returns when it ends', () => {
    expect(notchMode(run(mail(true)))).toBe('alert')
    expect(notchMode(run(mail(true), mail(false)))).toBe('peek')
    expect(notchMode(run({ type: 'pin-mini' }, mail(true)))).toBe('alert')
    expect(notchMode(run({ type: 'pointer', inside: true }, mail(true)))).toBe('alert')
  })

  it('shows over a hidden capsule too, and hides again when it ends', () => {
    expect(notchMode(run({ type: 'user-visibility', hidden: true }, mail(true)))).toBe('alert')
    expect(notchMode(run({ type: 'foreground', verdict: 'hidden' }, mail(true)))).toBe('alert')
    expect(notchMode(run({ type: 'user-visibility', hidden: true }, mail(true), mail(false)))).toBe('hidden')
    expect(notchMode(run({ type: 'foreground', verdict: 'hidden' }, mail(true), mail(false)))).toBe('hidden')
    expect(notchMode(run({ type: 'pin-mini' }, mail(true), mail(false)))).toBe('mini')
  })

  it('keeps the priority over a hidden capsule: permission, then reminder, then mail', () => {
    const hidden: NotchEvent = { type: 'user-visibility', hidden: true }
    const attention: NotchEvent = { type: 'attention', on: true }
    const due: NotchEvent = { type: 'reminders', due: true }
    expect(mailAlertShown(run(hidden, mail(true)))).toBe(true)
    expect(mailAlertShown(run(hidden, mail(true), attention))).toBe(false)
    expect(mailAlertShown(run(hidden, mail(true), due))).toBe(false)
    expect(run(hidden, mail(true), due, attention, { type: 'expand' }).view).toBe('permission')
    expect(run(hidden, mail(true), due, { type: 'expand' }).view).toBe('reminders')
    expect(run(hidden, mail(true), { type: 'expand' }).view).toBe('gmail')
  })

  it('leaves an expanded panel as it is, hidden or not', () => {
    const open = run({ type: 'user-visibility', hidden: true }, { type: 'open-integration', id: 'notes' })
    expect(reduceNotch(open, mail(true))).toBe(open)
    expect(notchMode(run({ type: 'foreground', verdict: 'hidden' }, { type: 'expand' }, { type: 'attention', on: true }))).toBe('expanded')
  })

  it('is ignored while a panel is open (expanded or any integration)', () => {
    const expanded = run({ type: 'expand' })
    expect(reduceNotch(expanded, mail(true))).toBe(expanded)
    const gmail = run({ type: 'open-integration', id: 'gmail' })
    expect(reduceNotch(gmail, mail(true))).toBe(gmail)
    expect(notchMode(run({ type: 'open-integration', id: 'notes' }, mail(true), { type: 'dismiss' }))).toBe('peek')
  })

  it('opens the gmail view when expanding with a mail alert, and is spent by opening the panel', () => {
    const open = run(mail(true), { type: 'expand' })
    expect(open).toMatchObject({ view: 'gmail', mailAlert: false })
    expect(notchMode(open)).toBe('gmail')
    expect(notchMode(run(mail(true), { type: 'toggle' }))).toBe('gmail')
    expect(notchMode(run(mail(true), { type: 'expand' }, { type: 'dismiss' }))).toBe('peek')
    expect(run(mail(true), { type: 'open-integration', id: 'notes' }).mailAlert).toBe(false)
  })

  it('yields to a Claude permission and a due reminder: their mode and their view (Review Focus 3)', () => {
    const attention: NotchEvent = { type: 'attention', on: true }
    const due: NotchEvent = { type: 'reminders', due: true }
    expect(notchMode(run(mail(true), attention))).toBe('alert')
    expect(run(mail(true), attention, { type: 'expand' }).view).toBe('permission')
    expect(run(attention, mail(true), { type: 'expand' }).view).toBe('permission')
    expect(run(mail(true), due, { type: 'expand' }).view).toBe('reminders')
    expect(run(due, mail(true), { type: 'expand' }).view).toBe('reminders')
  })

  it('ignores repeated mail events', () => {
    const state = run(mail(true))
    expect(reduceNotch(state, mail(true))).toBe(state)
    expect(reduceNotch(initialNotchState, mail(false))).toBe(initialNotchState)
  })
})

describe('mailAlertShown', () => {
  const mail = (on: boolean): NotchEvent => ({ type: 'mail', on })

  it('is true only while the alert capsule shows the new-mail alert', () => {
    expect(mailAlertShown(initialNotchState)).toBe(false)
    expect(mailAlertShown(run(mail(true)))).toBe(true)
    expect(mailAlertShown(run(mail(true), mail(false)))).toBe(false)
  })

  it('is false while a permission or a due reminder owns the alert', () => {
    expect(mailAlertShown(run(mail(true), { type: 'attention', on: true }))).toBe(false)
    expect(mailAlertShown(run(mail(true), { type: 'reminders', due: true }))).toBe(false)
    expect(mailAlertShown(run({ type: 'attention', on: true }))).toBe(false)
  })

  it('is true over a hidden capsule and false with a panel open', () => {
    expect(mailAlertShown(run(mail(true), { type: 'foreground', verdict: 'hidden' }))).toBe(true)
    expect(mailAlertShown(run(mail(true), { type: 'expand' }))).toBe(false)
  })
})

describe('isCapsuleHidden', () => {
  it('is true while the capsule is hidden (by the user or yielding), even under an alert, and false with a panel open', () => {
    expect(isCapsuleHidden(initialNotchState)).toBe(false)
    expect(isCapsuleHidden(run({ type: 'pin-mini' }))).toBe(false)
    expect(isCapsuleHidden(run({ type: 'foreground', verdict: 'hidden' }))).toBe(true)
    expect(isCapsuleHidden(run({ type: 'user-visibility', hidden: true }))).toBe(true)
    expect(isCapsuleHidden(run({ type: 'user-visibility', hidden: true }, { type: 'attention', on: true }))).toBe(true)
    expect(isCapsuleHidden(run({ type: 'foreground', verdict: 'hidden' }, { type: 'toggle' }))).toBe(false)
  })
})

describe('question (pending Claude question)', () => {
  const question = (on: boolean): NotchEvent => ({ type: 'question', on })
  const attention = (on: boolean): NotchEvent => ({ type: 'attention', on })
  const first = (kind: 'permission' | 'question'): NotchEvent => ({ type: 'claude-first', kind })

  it('starts without a question', () => {
    expect(initialNotchState.question).toBe(false)
    expect(initialNotchState.claudeFirst).toBe('permission')
  })

  it('shows the alert capsule over peek, mini and hidden, and goes back when it ends', () => {
    expect(notchMode(run(question(true)))).toBe('alert')
    expect(notchMode(run(question(true), question(false)))).toBe('peek')
    const mini = run({ type: 'pin-mini' })
    expect(notchMode(reduceNotch(mini, question(true)))).toBe('alert')
    expect(notchMode(run({ type: 'pin-mini' }, question(true), question(false)))).toBe('mini')
    for (const hidden of [run({ type: 'foreground', verdict: 'hidden' }), run({ type: 'user-visibility', hidden: true })]) {
      expect(notchMode(reduceNotch(hidden, question(true)))).toBe('alert')
      expect(notchMode(reduceNotch(reduceNotch(hidden, question(true)), question(false)))).toBe('hidden')
    }
  })

  it('opens on the question view, a panel mode that goes back to the integrations row', () => {
    expect(PANEL_MODES.has('question')).toBe(true)
    const open = run(question(true), { type: 'expand' })
    expect(open).toMatchObject({ expanded: true, view: 'question' })
    expect(notchMode(open)).toBe('question')
    expect(notchMode(run(question(true), { type: 'toggle' }))).toBe('question')
    expect(notchMode(run(question(true), { type: 'show' }))).toBe('question')
    expect(notchMode(reduceNotch(open, { type: 'back' }))).toBe('expanded')
    expect(notchMode(reduceNotch(open, { type: 'dismiss' }))).toBe('alert')
  })

  it('outranks a due reminder and new mail, which never own the alert while it is pending', () => {
    const state = run({ type: 'mail', on: true }, { type: 'reminders', due: true }, question(true))
    expect(notchMode(state)).toBe('alert')
    expect(mailAlertShown(run({ type: 'mail', on: true }, question(true)))).toBe(false)
    expect(reduceNotch(state, { type: 'expand' }).view).toBe('question')
  })

  it('opens the permission or the question, whichever arrived first (Review Focus 4)', () => {
    expect(run(attention(true), question(true), first('permission'), { type: 'expand' }).view).toBe('permission')
    expect(run(question(true), attention(true), first('question'), { type: 'expand' }).view).toBe('question')
    // The order only matters while both wait.
    expect(run(first('question'), attention(true), { type: 'expand' }).view).toBe('permission')
    expect(run(first('permission'), question(true), { type: 'expand' }).view).toBe('question')
  })

  it('moves an open permission card to the question that waits next', () => {
    // Permission first: deciding it lands on the question.
    const permissionOpen = run(attention(true), question(true), first('permission'), { type: 'expand' })
    expect(notchMode(reduceNotch(permissionOpen, attention(false)))).toBe('question')
    // Another permission still waits but the question arrived before it.
    expect(notchMode(reduceNotch(permissionOpen, first('question')))).toBe('question')
    // Nothing left: back to the integrations row, as before.
    expect(run(attention(true), { type: 'expand' }, attention(false)).view).toBe('home')
  })

  it('keeps the question card open when its question goes, until the card asks for the next item', () => {
    const open = run(question(true), attention(true), first('question'), { type: 'expand' })
    const answered = run(question(true), attention(true), first('question'), { type: 'expand' }, first('permission'), question(false))
    expect(notchMode(answered)).toBe('question')
    expect(notchMode(reduceNotch(answered, { type: 'next' }))).toBe('permission')
    // Answering the last pending item closes the panel; the capsule leaves the alert.
    const last = run(question(true), { type: 'expand' }, question(false))
    expect(notchMode(last)).toBe('question')
    const closed = reduceNotch(last, { type: 'next' })
    expect(closed).toMatchObject({ expanded: false, view: 'home' })
    expect(notchMode(closed)).toBe('peek')
    // More questions wait: the view stays (the card shows the next one).
    expect(reduceNotch(open, { type: 'next' })).toBe(open)
  })

  it('closes back to a hidden capsule after answering from the alert over it', () => {
    const state = run({ type: 'user-visibility', hidden: true }, question(true), { type: 'expand' }, question(false), { type: 'next' })
    expect(notchMode(state)).toBe('hidden')
  })

  it('ignores next outside a Claude card', () => {
    for (const start of [initialNotchState, run({ type: 'expand' }), run({ type: 'open-integration', id: 'notes' }), run(question(true))]) {
      expect(reduceNotch(start, { type: 'next' })).toBe(start)
    }
  })

  it('ignores repeated question and order events', () => {
    const on = run(question(true))
    expect(reduceNotch(on, question(true))).toBe(on)
    expect(reduceNotch(initialNotchState, question(false))).toBe(initialNotchState)
    expect(reduceNotch(initialNotchState, first('permission'))).toBe(initialNotchState)
  })
})

describe('reviewAlert (first review of own PR/MRs, same priority as mail)', () => {
  const review = (on: boolean): NotchEvent => ({ type: 'review', on })
  const mail = (on: boolean): NotchEvent => ({ type: 'mail', on })

  it('starts without a review alert; reviews is a panel mode', () => {
    expect(initialNotchState.reviewAlert).toBe(false)
    expect(PANEL_MODES.has('reviews')).toBe(true)
    const open = run({ type: 'open-integration', id: 'reviews' })
    expect(notchMode(open)).toBe('reviews')
    expect(notchMode(reduceNotch(open, { type: 'back' }))).toBe('expanded')
  })

  it('shows the alert over compact, mini and hidden, and goes back when it ends', () => {
    expect(notchMode(run(review(true)))).toBe('alert')
    expect(notchMode(run(review(true), review(false)))).toBe('peek')
    expect(notchMode(run({ type: 'pin-mini' }, review(true)))).toBe('alert')
    expect(notchMode(run({ type: 'pin-mini' }, review(true), review(false)))).toBe('mini')
    expect(notchMode(run({ type: 'user-visibility', hidden: true }, review(true)))).toBe('alert')
    expect(notchMode(run({ type: 'user-visibility', hidden: true }, review(true), review(false)))).toBe('hidden')
  })

  it('is dropped while a panel is open and spent by opening one; expanding opens the reviews view', () => {
    const expanded = run({ type: 'expand' })
    expect(reduceNotch(expanded, review(true))).toBe(expanded)
    const open = run(review(true), { type: 'expand' })
    expect(open).toMatchObject({ view: 'reviews', reviewAlert: false })
    expect(run(review(true), { type: 'open-integration', id: 'notes' }).reviewAlert).toBe(false)
    expect(run(review(true), { type: 'show' }).reviewAlert).toBe(false)
  })

  it('shares the lowest priority with mail: the newer replaces the older', () => {
    const reviewThenMail = run(review(true), mail(true))
    expect(reviewThenMail).toMatchObject({ reviewAlert: false, mailAlert: true })
    expect(mailAlertShown(reviewThenMail)).toBe(true)
    expect(reviewAlertShown(reviewThenMail)).toBe(false)
    const mailThenReview = run(mail(true), review(true))
    expect(mailThenReview).toMatchObject({ reviewAlert: true, mailAlert: false })
    expect(mailAlertShown(mailThenReview)).toBe(false)
    expect(reviewAlertShown(mailThenReview)).toBe(true)
    // The older one's timer ending later changes nothing.
    expect(reduceNotch(mailThenReview, mail(false))).toBe(mailThenReview)
  })

  it('yields to a permission, a question and a due reminder', () => {
    expect(reviewAlertShown(run(review(true)))).toBe(true)
    expect(reviewAlertShown(run(review(true), { type: 'attention', on: true }))).toBe(false)
    expect(reviewAlertShown(run(review(true), { type: 'question', on: true }))).toBe(false)
    expect(reviewAlertShown(run(review(true), { type: 'reminders', due: true }))).toBe(false)
    expect(run(review(true), { type: 'reminders', due: true }, { type: 'expand' }).view).toBe('reminders')
    expect(reviewAlertShown(run(review(true), { type: 'expand' }))).toBe(false)
  })

  it('mailAlertShown is false for a review alert alone', () => {
    expect(mailAlertShown(run(review(true)))).toBe(false)
  })
})
