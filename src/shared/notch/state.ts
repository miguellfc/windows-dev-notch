/** What the capsule shows. `hidden` means the window is not on screen at all. */
export type NotchMode = 'compact' | 'peek' | 'expanded' | 'mini' | 'hidden'

/** How the capsule yields to the window in front: nothing, shrink to a pill, or disappear. */
export type Yielding = 'none' | 'mini' | 'hidden'

export interface NotchState {
  readonly expanded: boolean
  readonly yielding: Yielding
  readonly userHidden: boolean
  readonly pointerInside: boolean
}

export type NotchEvent =
  | { readonly type: 'pointer'; readonly inside: boolean }
  | { readonly type: 'expand' }
  | { readonly type: 'toggle' }
  | { readonly type: 'dismiss' }
  | { readonly type: 'foreground'; readonly verdict: Yielding }
  | { readonly type: 'user-visibility'; readonly hidden: boolean }

export const initialNotchState: NotchState = Object.freeze({
  expanded: false,
  yielding: 'none',
  userHidden: false,
  pointerInside: false,
})

/** Explicit user intent (expand) beats yielding; yielding beats hover. */
export function notchMode(state: NotchState): NotchMode {
  if (state.expanded) return 'expanded'
  if (state.userHidden || state.yielding === 'hidden') return 'hidden'
  if (state.pointerInside) return 'peek'
  return state.yielding === 'mini' ? 'mini' : 'compact'
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
      return next(state, { expanded: true, userHidden: false })
    case 'toggle':
      return state.expanded ? next(state, { expanded: false }) : next(state, { expanded: true, userHidden: false })
    case 'dismiss':
      return next(state, { expanded: false })
    case 'foreground':
      return next(state, { yielding: event.verdict })
    case 'user-visibility':
      return event.hidden ? next(state, { userHidden: true, expanded: false }) : next(state, { userHidden: false })
  }
}
