import type { IntegrationId } from '../integrations/registry'

/**
 * What the capsule shows. `peek` (time and date) is the resting capsule, `compact` (metrics, mail,
 * reviews) the one under the pointer, `mini` the thin pill the user pins with a right click.
 * `hidden` means the window is not on screen at all.
 */
export type NotchMode = 'compact' | 'peek' | 'alert' | 'expanded' | 'permission' | 'question' | 'reminders' | 'system' | 'notes' | 'gmail' | 'reviews' | 'mini' | 'hidden'

/** What the open panel shows: the integrations row, or one integration. */
export type NotchView = 'home' | ClaudeItem | IntegrationId

/** The two kinds of pending Claude item: a permission request and an `AskUserQuestion` question. */
export type ClaudeItem = 'permission' | 'question'

/** Modes that show the panel and therefore own the keyboard focus. */
export const PANEL_MODES: ReadonlySet<NotchMode> = new Set<NotchMode>(['expanded', 'permission', 'question', 'reminders', 'system', 'notes', 'gmail', 'reviews'])

/** How long the new-mail alert stays in the capsule before it goes away on its own (main owns the timer). */
export const MAIL_ALERT_MS = 6_000

/**
 * How long compact stays after a left click on the pill if the pointer never enters it (main owns the
 * timer): long enough to read it, short enough that a pointer left at the screen edge rests in peek.
 */
export const STICKY_COMPACT_MS = 3_000

/** How long the first-review alert stays (main owns the timer), like the mail alert. */
export const REVIEW_ALERT_MS = 6_000

/**
 * How the capsule yields to the window in front: nothing, or disappear (fullscreen). Maximized windows
 * no longer shrink it: mini is the user's choice alone (`pinnedMini`).
 */
export type Yielding = 'none' | 'hidden'

export interface NotchState {
  readonly expanded: boolean
  readonly yielding: Yielding
  readonly userHidden: boolean
  readonly pointerInside: boolean
  /** The user pinned the thin pill (right click on the compact capsule); a left click on it unpins. Never persisted. */
  readonly pinnedMini: boolean
  /**
   * Compact right after a left click on the pill, wherever the pointer is: the pill sits at the screen
   * edge, above the compact capsule, so the pointer is off compact at once. Ends when the pointer enters
   * compact (then leaving it rests in peek as usual), on a panel, a new pin or hiding, or when main's
   * timer sends `sticky-end` ({@link STICKY_COMPACT_MS}).
   */
  readonly stickyCompact: boolean
  /** A Claude permission request is waiting for the user. */
  readonly attention: boolean
  /** At least one Claude question is waiting for an answer: the same alert level as a permission. */
  readonly question: boolean
  /**
   * Which pending Claude item arrived first (main knows both lists and their shared clock). Only
   * matters while a permission and a question both wait: the panel opens on the earliest.
   */
  readonly claudeFirst: ClaudeItem
  /** At least one reminder is due and not yet dismissed. */
  readonly reminderDue: boolean
  /** New mail arrived: the lowest-priority alert; main turns it off after 6 s. */
  readonly mailAlert: boolean
  /**
   * Own PR/MRs got their first review: the same lowest priority as mail (never both: the newer
   * replaces the older); main turns it off after 6 s.
   */
  readonly reviewAlert: boolean
  readonly view: NotchView
}

export type NotchEvent =
  | { readonly type: 'pointer'; readonly inside: boolean }
  /** Right click on the compact capsule: shrink to the thin pill at the top edge until a left click. */
  | { readonly type: 'pin-mini' }
  /** Left click on the pill: back to compact (the pointer is on it), then peek once it leaves. */
  | { readonly type: 'unpin-mini' }
  /** The sticky compact after unpinning timed out (main owns the timer). */
  | { readonly type: 'sticky-end' }
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
  /** Own PR/MRs got their first review (on), or the alert's 6 s ended (off). */
  | { readonly type: 'review'; readonly on: boolean }
  /** At least one Claude question is (or no longer is) waiting for an answer. */
  | { readonly type: 'question'; readonly on: boolean }
  /** The earliest pending Claude item changed kind (main sends it with the permission and question lists). */
  | { readonly type: 'claude-first'; readonly kind: ClaudeItem }
  /** The open question card is done (answered or gone): land on the next pending Claude item, or close. */
  | { readonly type: 'next' }

export const initialNotchState: NotchState = Object.freeze({
  expanded: false,
  yielding: 'none',
  userHidden: false,
  pointerInside: false,
  pinnedMini: false,
  stickyCompact: false,
  attention: false,
  question: false,
  claudeFirst: 'permission',
  reminderDue: false,
  mailAlert: false,
  reviewAlert: false,
  view: 'home',
})

/**
 * Explicit user intent (expand) beats alerts; a pending alert shows even over a hidden capsule
 * (hidden by the user or yielding to a fullscreen window); hiding beats the pinned mini, the pinned mini
 * beats hover, and hover turns the resting peek (time and date) into compact (metrics, mail, reviews).
 * The alert never touches the hiding flags: when it ends the capsule goes back to what it was.
 */
export function notchMode(state: NotchState): NotchMode {
  if (state.expanded) {
    return state.view === 'home' ? 'expanded' : state.view
  }
  if (state.attention || state.question || state.reminderDue || state.mailAlert || state.reviewAlert) return 'alert'
  if (isCapsuleHidden(state)) return 'hidden'
  if (state.pinnedMini) return 'mini'
  return state.pointerInside || state.stickyCompact ? 'compact' : 'peek'
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
 * permission, a question nor a due reminder (all outrank mail) owns it. Main sends this to the notch so the
 * renderer never guesses the alert's kind from its own, possibly late, stores.
 */
export function mailAlertShown(state: NotchState): boolean {
  return state.mailAlert && lowAlertOwnsCapsule(state)
}

/** Whether the alert capsule shows the first-review alert (same rule as {@link mailAlertShown}). */
export function reviewAlertShown(state: NotchState): boolean {
  return state.reviewAlert && lowAlertOwnsCapsule(state)
}

/** The capsule is in `alert` and no permission, question or due reminder (all outrank mail and reviews) owns it. */
const lowAlertOwnsCapsule = (state: NotchState): boolean =>
  notchMode(state) === 'alert' && !state.attention && !state.question && !state.reminderDue

/** The pending Claude item the panel shows first: a permission or a question, whichever arrived first. */
export function firstClaudeItem(state: Pick<NotchState, 'attention' | 'question' | 'claudeFirst'>): ClaudeItem | null {
  if (state.attention && state.question) return state.claudeFirst
  if (state.attention) return 'permission'
  return state.question ? 'question' : null
}

/**
 * A panel opened while something is pending lands on it: the earliest Claude permission or question
 * (same level), a due reminder, then new mail or a first review (never both at once).
 */
function openingView(state: NotchState): NotchView {
  if (state.expanded) return state.view
  const claude = firstClaudeItem(state)
  if (claude) return claude
  if (state.reminderDue) return 'reminders'
  if (state.mailAlert) return 'gmail'
  return state.reviewAlert ? 'reviews' : 'home'
}

/** Opening a panel spends the low-priority alerts: they are never shown with a panel open. */
const SPENT = { mailAlert: false, reviewAlert: false } as const

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
  const forgotten = nextState.pointerInside && notchMode(nextState) === 'hidden' ? next(nextState, { pointerInside: false }) : nextState
  // The sticky compact only bridges the click on the pill and the pointer reaching compact.
  const sticky = forgotten.stickyCompact && (forgotten.expanded || forgotten.pinnedMini || isCapsuleHidden(forgotten))
  return sticky ? next(forgotten, { stickyCompact: false }) : forgotten
}

/**
 * Applies a change to the Claude flags. An open permission card (it has no "sent" step) moves at once
 * to the Claude item that now comes first, or back to the integrations row when none is left.
 */
function withPermissionCard(state: NotchState, changes: Partial<Pick<NotchState, 'attention' | 'question' | 'claudeFirst'>>): NotchState {
  const changed = next(state, changes)
  if (changed === state || !state.expanded || state.view !== 'permission') return changed
  const claude = firstClaudeItem(changed)
  return claude === 'permission' ? changed : next(changed, { view: claude ?? 'home' })
}

function applyEvent(state: NotchState, event: NotchEvent): NotchState {
  switch (event.type) {
    case 'pointer':
      // Entering ends the sticky compact: from then on, leaving rests in peek.
      return event.inside ? next(state, { pointerInside: true, stickyCompact: false }) : next(state, { pointerInside: false })
    case 'sticky-end':
      return next(state, { stickyCompact: false })
    case 'pin-mini':
      // Only the resting or hovered capsule takes a right click: never with a panel open, an alert
      // showing or the capsule hidden (a late click must not pin a pill nobody can see).
      return notchMode(state) === 'peek' || notchMode(state) === 'compact' ? next(state, { pinnedMini: true }) : state
    case 'unpin-mini':
      // The click came from the pill, above compact: compact sticks until the pointer has been on it.
      return state.pinnedMini ? next(state, { pinnedMini: false, stickyCompact: true }) : state
    // Opening the panel spends the mail and review alerts: they are never shown with a panel open.
    case 'expand':
      return next(state, { expanded: true, userHidden: userHiddenOnOpen(state), ...SPENT, view: openingView(state) })
    // Like expand, but it always clears the user's "hide", even from an alert over the hidden capsule.
    case 'show':
      return next(state, { expanded: true, userHidden: false, ...SPENT, view: openingView(state) })
    case 'toggle':
      return state.expanded
        ? next(state, { expanded: false, view: 'home' })
        : next(state, { expanded: true, userHidden: userHiddenOnOpen(state), ...SPENT, view: openingView(state) })
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
      return next(state, { expanded: true, userHidden: userHiddenOnOpen(state), ...SPENT, view: event.id })
    case 'attention':
      // Attention never opens or closes the panel; an open permission card moves on to what waits next.
      return withPermissionCard(state, { attention: event.on })
    case 'claude-first':
      return withPermissionCard(state, { claudeFirst: event.kind })
    case 'reminders':
      // Like attention, a due reminder never opens or closes the panel; an open reminders view stays as it is.
      return next(state, { reminderDue: event.due })
    case 'mail':
      // The lowest-priority alert: with a panel open it is dropped, not queued.
      // The newer of mail and review replaces the older one: one low-priority alert at a time.
      if (event.on) return state.expanded ? state : next(state, { mailAlert: true, reviewAlert: false })
      return next(state, { mailAlert: false })
    case 'review':
      if (event.on) return state.expanded ? state : next(state, { reviewAlert: true, mailAlert: false })
      return next(state, { reviewAlert: false })
    case 'question':
      // Never opens or closes the panel. An open question card stays: it shows "sent" or "no longer
      // pending" and then asks for the next item itself (`next`).
      return withPermissionCard(state, { question: event.on })
    case 'next': {
      if (!state.expanded || (state.view !== 'question' && state.view !== 'permission')) return state
      const claude = firstClaudeItem(state)
      return claude ? next(state, { view: claude }) : next(state, { expanded: false, view: 'home' })
    }
    case 'back':
      return state.expanded ? next(state, { view: 'home' }) : state
  }
}
