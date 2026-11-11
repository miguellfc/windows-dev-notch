import type { IntegrationId } from '../integrations/registry'

/** What the capsule shows. `hidden` means the window is not on screen at all. */
export type NotchMode = 'compact' | 'peek' | 'alert' | 'expanded' | 'terminal' | 'permission' | 'reminders' | 'system' | 'notes' | 'mini' | 'hidden'

/** What the open panel shows: the integrations row, or one integration. */
export type NotchView = 'home' | 'permission' | IntegrationId

/** Modes that show the panel and therefore own the keyboard focus. */
export const PANEL_MODES: ReadonlySet<NotchMode> = new Set<NotchMode>(['expanded', 'terminal', 'permission', 'reminders', 'system', 'notes'])

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
  readonly view: NotchView
}

export type NotchEvent =
  | { readonly type: 'pointer'; readonly inside: boolean }
  | { readonly type: 'expand' }
  | { readonly type: 'toggle' }
  | { readonly type: 'dismiss' }
  | { readonly type: 'foreground'; readonly verdict: Yielding }
  | { readonly type: 'user-visibility'; readonly hidden: boolean }
  | { readonly type: 'open-integration'; readonly id: IntegrationId }
  | { readonly type: 'back' }
  | { readonly type: 'attention'; readonly on: boolean }
  | { readonly type: 'reminders'; readonly due: boolean }

export const initialNotchState: NotchState = Object.freeze({
  expanded: false,
  yielding: 'none',
  userHidden: false,
  pointerInside: false,
  attention: false,
  reminderDue: false,
  view: 'home',
})

/** Explicit user intent (expand) beats yielding; yielding beats hover. */
export function notchMode(state: NotchState): NotchMode {
  if (state.expanded) {
    if (state.view === 'terminal' || state.view === 'permission' || state.view === 'reminders' || state.view === 'system' || state.view === 'notes') return state.view
    return 'expanded'
  }
  if (state.userHidden || state.yielding === 'hidden') return 'hidden'
  if (state.attention || state.reminderDue) return 'alert'
  if (state.pointerInside) return 'peek'
  return state.yielding === 'mini' ? 'mini' : 'compact'
}

/** A panel opened while something is pending lands on it: a permission first, then a due reminder. */
function openingView(state: NotchState): NotchView {
  if (state.expanded) return state.view
  if (state.attention) return 'permission'
  return state.reminderDue ? 'reminders' : 'home'
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
    case 'expand':
      return next(state, { expanded: true, userHidden: false, view: openingView(state) })
    case 'toggle':
      return state.expanded
        ? next(state, { expanded: false, view: 'home' })
        : next(state, { expanded: true, userHidden: false, view: openingView(state) })
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
      return next(state, { expanded: true, userHidden: false, view: event.id })
    case 'attention':
      // Attention never opens or closes the panel; only an open permission card has nothing left to show.
      return next(state, { attention: event.on, ...(!event.on && state.view === 'permission' ? { view: 'home' as const } : {}) })
    case 'reminders':
      // Like attention, a due reminder never opens or closes the panel; an open reminders view stays as it is.
      return next(state, { reminderDue: event.due })
    case 'back':
      return state.expanded ? next(state, { view: 'home' }) : state
  }
}
