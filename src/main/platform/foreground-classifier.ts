import type { Yielding } from '../../shared/notch/state'

export type ForegroundVerdict = Yielding

export interface MonitorRect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/** Windows' own view of the session (SHQueryUserNotificationState), simplified. */
export type NotificationState = 'normal' | 'busy' | 'd3d' | 'presentation' | 'app' | 'unknown'

export interface ForegroundSnapshot {
  readonly handle: string | null
  readonly className: string
  /** The window covers its whole monitor (borderless fullscreen, F11, games). */
  readonly coversMonitor: boolean
  /** Monitor of the foreground window, in physical pixels. */
  readonly monitor: MonitorRect
  readonly notificationState: NotificationState
}

export interface ClassifyContext {
  readonly ownHandles: readonly string[]
  /** Monitor the capsule lives on, in physical pixels. */
  readonly notchMonitor: MonitorRect
}

const DESKTOP_CLASSES = new Set(['Progman', 'WorkerW'])
const TASKBAR_CLASSES = new Set(['Shell_TrayWnd', 'Shell_SecondaryTrayWnd'])
const FULLSCREEN_STATES = new Set<NotificationState>(['busy', 'd3d', 'presentation', 'app'])

const sameMonitor = (a: MonitorRect, b: MonitorRect) =>
  a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom

/**
 * Decides how the capsule should yield to the foreground window: only fullscreen hides it. A maximized
 * window no longer shrinks it (the thin pill is the user's choice: a right click on the capsule).
 * Geometry is checked first because Windows reports fullscreen ~0.5 s late (M0).
 * `keep` means "this window says nothing new": our own windows, the taskbar, unknown.
 */
export function classifyForeground(snapshot: ForegroundSnapshot, context: ClassifyContext): ForegroundVerdict | 'keep' {
  if (snapshot.handle === null || context.ownHandles.includes(snapshot.handle)) return 'keep'
  if (TASKBAR_CLASSES.has(snapshot.className)) return 'keep'
  if (DESKTOP_CLASSES.has(snapshot.className)) return 'none'

  if (!sameMonitor(snapshot.monitor, context.notchMonitor)) {
    // A fullscreen app elsewhere does not concern this monitor; presentation mode is system-wide.
    return snapshot.notificationState === 'presentation' ? 'hidden' : 'none'
  }

  if (snapshot.coversMonitor || FULLSCREEN_STATES.has(snapshot.notificationState)) return 'hidden'
  return 'none'
}
