import { resizeOrder, windowBoundsFor, type Rect, type VisibleMode } from '../../shared/notch/geometry'
import {
  initialNotchState,
  isCapsuleHidden,
  MAIL_ALERT_MS,
  mailAlertShown,
  notchMode,
  PANEL_MODES,
  reduceNotch,
  REDMINE_ALERT_MS,
  redmineAlertShown,
  REVIEW_ALERT_MS,
  reviewAlertShown,
  STICKY_COMPACT_MS,
  type NotchEvent,
  type NotchMode,
} from '../../shared/notch/state'

export { MAIL_ALERT_MS, REDMINE_ALERT_MS, REVIEW_ALERT_MS, STICKY_COMPACT_MS }
import type { Logger } from '../services/logger'

/** What the controller needs from the capsule window; the Electron adapter implements it. */
export interface NotchSurface {
  setBounds(rect: Rect): void
  /** Show without stealing focus. */
  show(): void
  hide(): void
  focus(): void
  blur(): void
  setIgnoreMouse(ignore: boolean): void
  sendMode(mode: NotchMode): void
  /** Whether the alert capsule shows the new-mail alert; sent before the mode that shows it. */
  sendMailAlert(on: boolean): void
  /** Whether the alert capsule shows the first-review alert; sent before the mode that shows it. */
  sendReviewAlert(on: boolean): void
  /** Whether the alert capsule shows the end-of-day Redmine alert; sent before the mode that shows it. */
  sendRedmineAlert(on: boolean): void
}

export interface NotchControllerOptions {
  surface: NotchSurface
  workArea: Rect
  logger: Logger
  /** Fallback if the renderer never reports the end of a shrinking animation. */
  settleTimeoutMs?: number
  onModeChange?: (mode: NotchMode) => void
  /** The capsule became hidden or shown again (by the user or yielding); alerts over it do not count. */
  onHiddenChange?: (hidden: boolean) => void
}

export interface NotchController {
  /** The window is ready: show it in whatever state events have produced so far. */
  start(): void
  dispatch(event: NotchEvent): void
  /** The renderer finished a shrinking animation; the window may shrink now. */
  settled(): void
  setWorkArea(workArea: Rect): void
  mode(): NotchMode
  /**
   * Whether the capsule is hidden (by the user or yielding) with no panel open. An alert shows the
   * window over it while the capsule stays hidden: the tray offers "Show", not "Hide".
   */
  hidden(): boolean
  /** Stops pending work; the controller ignores everything afterwards. */
  dispose(): void
}

/**
 * Owns the capsule's state and drives the window in the order M0 validated:
 * grow the window then animate; animate then shrink the window. It compares against the
 * size the window actually has, so a shrink still in progress is never cut short.
 */
export function createNotchController(options: NotchControllerOptions): NotchController {
  const { surface, settleTimeoutMs = 500, onModeChange, onHiddenChange } = options
  const log = options.logger.child('notch')
  let state = initialNotchState
  let mode: NotchMode = notchMode(state)
  /** Last value of {@link mailAlertShown}, sent to the renderer whenever it changes. */
  let mailShown = false
  /** Last value of {@link reviewAlertShown}, sent like `mailShown`. */
  let reviewShown = false
  /** Last value of {@link redmineAlertShown}, sent like `mailShown`. */
  let redmineShown = false
  /** Last value of {@link isCapsuleHidden}, reported through `onHiddenChange`. */
  let hidden = isCapsuleHidden(state)
  let workArea = options.workArea
  /** Mode the window is currently sized for (may be larger than `mode` while shrinking). */
  let windowMode: VisibleMode = 'peek'
  let pendingShrink: { target: VisibleMode; timer: ReturnType<typeof setTimeout> } | null = null
  let mailTimer: ReturnType<typeof setTimeout> | null = null
  let reviewTimer: ReturnType<typeof setTimeout> | null = null
  let redmineTimer: ReturnType<typeof setTimeout> | null = null
  /** Ends the sticky compact after a click on the pill if the pointer never reaches compact. */
  let stickyTimer: ReturnType<typeof setTimeout> | null = null
  let started = false
  let disposed = false

  const bounds = (m: VisibleMode) => windowBoundsFor(m, workArea)

  const clearMailTimer = () => {
    if (mailTimer !== null) clearTimeout(mailTimer)
    mailTimer = null
  }

  const clearReviewTimer = () => {
    if (reviewTimer !== null) clearTimeout(reviewTimer)
    reviewTimer = null
  }

  const clearRedmineTimer = () => {
    if (redmineTimer !== null) clearTimeout(redmineTimer)
    redmineTimer = null
  }

  const clearStickyTimer = () => {
    if (stickyTimer !== null) clearTimeout(stickyTimer)
    stickyTimer = null
  }

  const cancelPendingShrink = () => {
    if (pendingShrink) clearTimeout(pendingShrink.timer)
    pendingShrink = null
  }

  const resizeTo = (target: VisibleMode) => {
    surface.setBounds(bounds(target))
    windowMode = target
  }

  const finishShrink = () => {
    if (!pendingShrink || disposed) return
    const { target } = pendingShrink
    cancelPendingShrink()
    resizeTo(target)
  }

  const transition = (from: NotchMode, to: NotchMode) => {
    cancelPendingShrink()
    if (to === 'hidden') {
      surface.sendMode('hidden')
      surface.hide()
      surface.setIgnoreMouse(true)
    } else if (from === 'hidden') {
      resizeTo(to)
      surface.sendMode(to)
      surface.show()
    } else if (resizeOrder(windowMode, to) === 'resize-first') {
      resizeTo(to)
      surface.sendMode(to)
    } else {
      surface.sendMode(to)
      pendingShrink = { target: to, timer: setTimeout(finishShrink, settleTimeoutMs) }
    }
    // Focus belongs to the panel; moving between panel views keeps it, leaving gives it back.
    if (PANEL_MODES.has(to) && !PANEL_MODES.has(from)) surface.focus()
    else if (PANEL_MODES.has(from) && !PANEL_MODES.has(to)) surface.blur()
  }

  const controller: NotchController = {
    start() {
      if (started || disposed) return
      started = true
      if (mode !== 'hidden') resizeTo(mode)
      surface.setIgnoreMouse(true)
      if (mailShown) surface.sendMailAlert(true)
      if (reviewShown) surface.sendReviewAlert(true)
      if (redmineShown) surface.sendRedmineAlert(true)
      surface.sendMode(mode)
      if (mode === 'hidden') surface.hide()
      else surface.show()
    },
    dispatch(event) {
      if (disposed) return
      if (event.type === 'mail' && event.on) {
        // Never shown with a panel open (the state drops it too); each new mail restarts the 6 s.
        if (PANEL_MODES.has(mode)) return
        clearMailTimer()
        mailTimer = setTimeout(() => {
          mailTimer = null
          controller.dispatch({ type: 'mail', on: false })
        }, MAIL_ALERT_MS)
      }
      if (event.type === 'review' && event.on) {
        // Same rules as mail: dropped with a panel open; each new review alert restarts the 6 s.
        if (PANEL_MODES.has(mode)) return
        clearReviewTimer()
        reviewTimer = setTimeout(() => {
          reviewTimer = null
          controller.dispatch({ type: 'review', on: false })
        }, REVIEW_ALERT_MS)
      }
      if (event.type === 'redmine' && event.on) {
        // Same rules as mail: dropped with a panel open; each new alert restarts the 6 s.
        if (PANEL_MODES.has(mode)) return
        clearRedmineTimer()
        redmineTimer = setTimeout(() => {
          redmineTimer = null
          controller.dispatch({ type: 'redmine', on: false })
        }, REDMINE_ALERT_MS)
      }
      const nextState = reduceNotch(state, event)
      if (nextState === state) return
      // The sticky compact (after a click on the pill) has a deadline; anything that ends it first clears it.
      if (nextState.stickyCompact && !state.stickyCompact) {
        clearStickyTimer()
        stickyTimer = setTimeout(() => {
          stickyTimer = null
          controller.dispatch({ type: 'sticky-end' })
        }, STICKY_COMPACT_MS)
      } else if (!nextState.stickyCompact) {
        clearStickyTimer()
      }
      state = nextState
      // The alert's kind can change while the mode stays `alert` (a permission over a mail alert, a
      // review replacing mail), and it reaches the renderer before a mode change that shows it. The
      // ones turning off go first, so the renderer never sees two on.
      const shown = { mail: mailAlertShown(state), review: reviewAlertShown(state), redmine: redmineAlertShown(state) }
      const send = (kind: 'mail' | 'review' | 'redmine', on: boolean) => {
        if (on === (kind === 'mail' ? mailShown : kind === 'review' ? reviewShown : redmineShown)) return
        if (kind === 'mail') mailShown = on
        else if (kind === 'review') reviewShown = on
        else redmineShown = on
        if (!started) return
        if (kind === 'mail') surface.sendMailAlert(on)
        else if (kind === 'review') surface.sendReviewAlert(on)
        else surface.sendRedmineAlert(on)
      }
      const kinds = ['mail', 'review', 'redmine'] as const
      for (const kind of kinds) if (!shown[kind]) send(kind, false)
      for (const kind of kinds) if (shown[kind]) send(kind, true)
      const nextMode = notchMode(state)
      if (nextMode !== mode) {
        const from = mode
        mode = nextMode
        log.debug('Mode change', { from, to: nextMode, event: event.type })
        // Before the window is ready only the state moves; start() applies it.
        if (started) transition(from, nextMode)
        onModeChange?.(nextMode)
      }
      const nextHidden = isCapsuleHidden(state)
      if (nextHidden !== hidden) {
        hidden = nextHidden
        onHiddenChange?.(hidden)
      }
      if (started && event.type === 'pointer' && mode !== 'hidden') surface.setIgnoreMouse(!event.inside)
    },
    settled: finishShrink,
    setWorkArea(next) {
      workArea = next
      if (!started || disposed || mode === 'hidden') return
      cancelPendingShrink()
      resizeTo(mode)
    },
    mode: () => mode,
    hidden: () => hidden,
    dispose() {
      disposed = true
      cancelPendingShrink()
      clearMailTimer()
      clearReviewTimer()
      clearRedmineTimer()
      clearStickyTimer()
    },
  }
  return controller
}
