import { CAPSULE_SIZES, windowBoundsFor, type Rect, type VisibleMode } from '../../shared/notch/geometry'
import { initialNotchState, notchMode, PANEL_MODES, reduceNotch, type NotchEvent, type NotchMode } from '../../shared/notch/state'
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
}

export interface NotchControllerOptions {
  surface: NotchSurface
  workArea: Rect
  logger: Logger
  /** Fallback if the renderer never reports the end of a shrinking animation. */
  settleTimeoutMs?: number
  onModeChange?: (mode: NotchMode) => void
}

export interface NotchController {
  /** The window is ready: show it in whatever state events have produced so far. */
  start(): void
  dispatch(event: NotchEvent): void
  /** The renderer finished a shrinking animation; the window may shrink now. */
  settled(): void
  setWorkArea(workArea: Rect): void
  mode(): NotchMode
  /** Stops pending work; the controller ignores everything afterwards. */
  dispose(): void
}

const area = (mode: VisibleMode) => CAPSULE_SIZES[mode].width * CAPSULE_SIZES[mode].height

/**
 * Owns the capsule's state and drives the window in the order M0 validated:
 * grow the window then animate; animate then shrink the window. It compares against the
 * size the window actually has, so a shrink still in progress is never cut short.
 */
export function createNotchController(options: NotchControllerOptions): NotchController {
  const { surface, settleTimeoutMs = 500, onModeChange } = options
  const log = options.logger.child('notch')
  let state = initialNotchState
  let mode: NotchMode = notchMode(state)
  let workArea = options.workArea
  /** Mode the window is currently sized for (may be larger than `mode` while shrinking). */
  let windowMode: VisibleMode = 'compact'
  let pendingShrink: { target: VisibleMode; timer: ReturnType<typeof setTimeout> } | null = null
  let started = false
  let disposed = false

  const bounds = (m: VisibleMode) => windowBoundsFor(m, workArea)

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
    } else if (area(to) >= area(windowMode)) {
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

  return {
    start() {
      if (started || disposed) return
      started = true
      if (mode !== 'hidden') resizeTo(mode)
      surface.setIgnoreMouse(true)
      surface.sendMode(mode)
      if (mode === 'hidden') surface.hide()
      else surface.show()
    },
    dispatch(event) {
      if (disposed) return
      const nextState = reduceNotch(state, event)
      if (nextState === state) return
      state = nextState
      const nextMode = notchMode(state)
      if (nextMode !== mode) {
        const from = mode
        mode = nextMode
        log.debug('Mode change', { from, to: nextMode, event: event.type })
        // Before the window is ready only the state moves; start() applies it.
        if (started) transition(from, nextMode)
        onModeChange?.(nextMode)
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
    dispose() {
      disposed = true
      cancelPendingShrink()
    },
  }
}
