import type { Logger } from '../services/logger'
import type { ForegroundSnapshot, MonitorRect, NotificationState } from './foreground-classifier'

export interface ForegroundProbe {
  snapshot(): ForegroundSnapshot
}

const QUNS: Record<number, NotificationState> = {
  1: 'normal', // not present
  2: 'busy', // fullscreen app
  3: 'd3d',
  4: 'presentation',
  5: 'normal', // accepts notifications
  6: 'normal', // quiet time
  7: 'app',
}

/**
 * Win32 reads for the foreground watcher (validated in M0). Returns null when koffi
 * cannot load, so the app keeps working without automatic mini/hidden.
 */
export function createWin32ForegroundProbe(logger: Logger): ForegroundProbe | null {
  try {
    // Loaded lazily so a broken native module never prevents startup.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as typeof import('koffi')
    const user32 = koffi.load('user32.dll')
    const shell32 = koffi.load('shell32.dll')

    koffi.pointer('HWND', koffi.opaque())
    const RECT = koffi.struct('NOTCH_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
    const MONITORINFO = koffi.struct('NOTCH_MONITORINFO', {
      cbSize: 'uint32',
      rcMonitor: RECT,
      rcWork: RECT,
      dwFlags: 'uint32',
    })

    const GetForegroundWindow = user32.func('HWND __stdcall GetForegroundWindow()')
    const IsZoomed = user32.func('bool __stdcall IsZoomed(HWND hWnd)')
    const GetWindowRect = user32.func('bool __stdcall GetWindowRect(HWND hWnd, _Out_ NOTCH_RECT *rect)')
    const MonitorFromWindow = user32.func('void * __stdcall MonitorFromWindow(HWND hwnd, uint32_t flags)')
    const GetMonitorInfoW = user32.func('bool __stdcall GetMonitorInfoW(void *monitor, _Inout_ NOTCH_MONITORINFO *info)')
    const GetClassNameW = user32.func('int __stdcall GetClassNameW(HWND hWnd, void *name, int max)')
    const SHQueryUserNotificationState = shell32.func('long __stdcall SHQueryUserNotificationState(_Out_ int *state)')

    const className = (hwnd: unknown) => {
      const buffer = Buffer.alloc(512)
      const length = GetClassNameW(hwnd, buffer, 256) as number
      return buffer.toString('utf16le', 0, Math.max(0, length) * 2)
    }

    return {
      snapshot(): ForegroundSnapshot {
        const notification = [0]
        const hr = SHQueryUserNotificationState(notification) as number
        const notificationState: NotificationState = hr === 0 ? (QUNS[notification[0] ?? 0] ?? 'unknown') : 'unknown'

        const hwnd = GetForegroundWindow()
        const emptyMonitor: MonitorRect = { left: 0, top: 0, right: 0, bottom: 0 }
        if (!hwnd) {
          return { handle: null, className: '', zoomed: false, coversMonitor: false, monitor: emptyMonitor, notificationState }
        }

        const rect = { left: 0, top: 0, right: 0, bottom: 0 }
        GetWindowRect(hwnd, rect)
        const info = { cbSize: koffi.sizeof(MONITORINFO), rcMonitor: { ...emptyMonitor }, rcWork: { ...emptyMonitor }, dwFlags: 0 }
        GetMonitorInfoW(MonitorFromWindow(hwnd, 2 /* MONITOR_DEFAULTTONEAREST */), info)
        const monitor = info.rcMonitor

        return {
          handle: koffi.address(hwnd).toString(),
          className: className(hwnd),
          zoomed: Boolean(IsZoomed(hwnd)),
          coversMonitor:
            rect.left <= monitor.left && rect.top <= monitor.top && rect.right >= monitor.right && rect.bottom >= monitor.bottom,
          monitor,
          notificationState,
        }
      },
    }
  } catch (error) {
    logger.child('foreground').error('Win32 bindings unavailable; automatic mini/hidden disabled', { error })
    return null
  }
}
