import type { IntegrationId } from '../integrations/registry'

/** What the capsule shows. `hidden` means the window is not on screen at all. */
export type NotchMode = 'compact' | 'peek' | 'alert' | 'expanded' | 'terminal' | 'permission' | 'reminders' | 'system' | 'notes' | 'gmail' | 'mini' | 'hidden'

/** What the open panel shows: the integrations row, or one integration. */
export type NotchView = 'home' | 'permission' | IntegrationId

/** Modes that show the panel and therefore own the keyboard focus. */
export const PANEL_MODES: ReadonlySet<NotchMode> = new Set<NotchMode>(['expanded', 'terminal', 'permission', 'reminders', 'system', 'notes', 'gmail'])

/** How long the new-mail alert stays in the capsule before it goes away on its own (main owns the timer). */
export const MAIL_ALERT_MS = 6_000

/** How the capsule yields to the window in front: nothing, shrink to a pill, or disappear. */
export type Yielding = 'none' | 'mini' | 'hidden'

export interface NotchState {
  readonly expanded: boolean
  readonly yielding: Yielding
  readonly userHidden: boolean
  readonly pointerInside: boolean
  /** A Claude permission request is waiting for the user. */
  readonly attention: boolean
  /** At least one reminder is due and not yet dismissed. */
  readonly reminderDue: boolean
  /** New mail arrived: the lowest-priority alert; main turns it off after 6 s. */
  readonly mailAlert: boolean
  readonly view: NotchView
}

export type NotchEvent =
  | { readonly type: 'pointer'; readonly inside: boolean }
  | { readonly type: 'expand' }
  /** The user asks to see the notch (tray icon, tray "Show"): un-hides and opens the panel. */
  | { readonly type: 'show' }
  | { readonly type: 'toggle' }
  | { readonly type: 'dismiss' }
  | { readonly type: 'foreground'; readonly verdict: Yielding }
  | { readonly type: 'user-visibility'; readonly hidden: boolean }
  | { readonly type: 'open-integration'; readonly id: IntegrationId }
  | { readonly type: 'back' }
  | { readonly type: 'attention'; readonly on: boolean }
  | { readonly type: 'reminders'; readonly due: boolean }
  | { readonly type: 'mail'; readonly on: boolean }

export const initialNotchState: NotchState = Object.freeze({
  expanded: false,
  yielding: 'none',
  userHidden: false,
  pointerInside: false,
  attention: false,
  reminderDue: false,
  mailAlert: false,
  view: 'home',
})

/**
 * Explicit user intent (expand) beats alerts; a pending alert shows even over a hidden capsule
 * (hidden by the user or yielding to a fullscreen window); hiding beats yielding to mini and hover.
 * The alert never touches the hiding flags: when it ends the capsule goes back to what it was.
 */
export function notchMode(state: NotchState): NotchMode {
  if (state.expanded) {
    return state.view === 'home' ? 'expanded' : state.view
  }
  if (state.attention || state.reminderDue || state.mailAlert) return 'alert'
  if (isCapsuleHidden(state)) return 'hidden'
  if (state.pointerInside) return 'peek'
  return state.yielding === 'mini' ? 'mini' : 'compact'
}

/** The capsule is off screen apart from alerts: hidden by the user or yielding, with no panel open. */
export function isCapsuleHidden(state: NotchState): boolean {
  return !state.expanded && (state.userHidden || state.yielding === 'hidden')
}

/**
 * Opening a panel shows the capsule again (clears the user's "hide"), except when it opens from an
 * alert over a hidden capsule: closing that panel goes back to hidden. Moving between views of an
 * open panel keeps the flag as it is.
 */
const userHiddenOnOpen = (state: NotchState): boolean =>
  state.userHidden && (state.expanded || notchMode(state) === 'alert')

/**
 * Whether the alert capsule shows the new-mail alert: the capsule is in `alert` and neither a
 * permission nor a due reminder (both outrank mail) owns it. Main sends this to the notch so the
 * renderer never guesses the alert's kind from its own, possibly late, stores.
 */
export function mailAlertShown(state: NotchState): boolean {
  return notchMode(state) === 'alert' && !state.attention && !state.reminderDue
}

/** A panel opened while something is pending lands on it: a permission, a due reminder, then new mail. */
function openingView(state: NotchState): NotchView {
  if (state.expanded) return state.view
  if (state.attention) return 'permission'
  if (state.reminderDue) return 'reminders'
  return state.mailAlert ? 'gmail' : 'home'
}

function next(state: NotchState, changes: Partial<NotchState>): NotchState {
  const keys = Object.keys(changes) as (keyof NotchState)[]
  if (keys.every((key) => state[key] === changes[key])) return state
  return Object.freeze({ ...state, ...changes })
}

/**
 * Pure transition function. Returns the same object when nothing changes, so callers
 * can ignore repeated requests (M0: Esc + blur both asked to close).
 */
export function reduceNotch(state: NotchState, event: NotchEvent): NotchState {
  const nextState = applyEvent(state, event)
  // A hidden window never receives pointerleave, so forget the pointer when the capsule disappears.
  return nextState.pointerInside && notchMode(nextState) === 'hidden' ? next(nextState, { pointerInside: false }) : nextState
}

function applyEvent(state: NotchState, event: NotchEvent): NotchState {
  switch (event.type) {
    case 'pointer':
      return next(state, { pointerInside: event.inside })
    // Opening the panel spends the mail alert: it is never shown with a panel open.
    case 'expand':
      return next(state, { expanded: true, userHidden: userHiddenOnOpen(state), mailAlert: false, view: openingView(state) })
    // Like expand, but it always clears the user's "hide", even from an alert over the hidden capsule.
    case 'show':
      return next(state, { expanded: true, userHidden: false, mailAlert: false, view: openingView(state) })
    case 'toggle':
      return state.expanded
        ? next(state, { expanded: false, view: 'home' })
        : next(state, { expanded: true, userHidden: userHiddenOnOpen(state), mailAlert: false, view: openingView(state) })
    case 'dismiss':
      // Closing always forgets the view: the panel reopens on the integrations row.
      return next(state, { expanded: false, view: 'home' })
    case 'foreground':
      return next(state, { yielding: event.verdict })
    case 'user-visibility':
      return event.hidden
        ? next(state, { userHidden: true, expanded: false, view: 'home' })
        : next(state, { userHidden: false })
    case 'open-integration':
      return next(state, { expanded: true, userHidden: userHiddenOnOpen(state), mailAlert: false, view: event.id })
    case 'attention':
      // Attention never opens or closes the panel; only an open permission card has nothing left to show.
      return next(state, { attention: event.on, ...(!event.on && state.view === 'permission' ? { view: 'home' as const } : {}) })
    case 'reminders':
      // Like attention, a due reminder never opens or closes the panel; an open reminders view stays as it is.
      return next(state, { reminderDue: event.due })
    case 'mail':
      // The lowest-priority alert: with a panel open it is dropped, not queued.
      return event.on && state.expanded ? state : next(state, { mailAlert: event.on })
    case 'back':
      return state.expanded ? next(state, { view: 'home' }) : state
  }
}
