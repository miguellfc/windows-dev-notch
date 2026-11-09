// THROWAWAY M0 spike: minimal Win32 bindings through koffi.
const koffi = require('koffi')

const user32 = koffi.load('user32.dll')
const shell32 = koffi.load('shell32.dll')
const kernel32 = koffi.load('kernel32.dll')

const HWND = koffi.pointer('HWND', koffi.opaque())
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
const MONITORINFO = koffi.struct('MONITORINFO', {
  cbSize: 'uint32',
  rcMonitor: RECT,
  rcWork: RECT,
  dwFlags: 'uint32',
})
const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(HWND hwnd, intptr_t lParam)')

const fn = {
  GetForegroundWindow: user32.func('HWND __stdcall GetForegroundWindow()'),
  IsZoomed: user32.func('bool __stdcall IsZoomed(HWND hWnd)'),
  IsIconic: user32.func('bool __stdcall IsIconic(HWND hWnd)'),
  IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(HWND hWnd)'),
  GetWindowRect: user32.func('bool __stdcall GetWindowRect(HWND hWnd, _Out_ RECT *lpRect)'),
  MonitorFromWindow: user32.func('void * __stdcall MonitorFromWindow(HWND hwnd, uint32_t flags)'),
  GetMonitorInfoW: user32.func('bool __stdcall GetMonitorInfoW(void *hMonitor, _Inout_ MONITORINFO *lpmi)'),
  GetWindowTextW: user32.func('int __stdcall GetWindowTextW(HWND hWnd, void *lpString, int nMaxCount)'),
  GetClassNameW: user32.func('int __stdcall GetClassNameW(HWND hWnd, void *lpClassName, int nMaxCount)'),
  GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(HWND hWnd, _Out_ uint32_t *pid)'),
  EnumWindows: user32.func('bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lParam)'),
  SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(HWND hWnd)'),
  ShowWindow: user32.func('bool __stdcall ShowWindow(HWND hWnd, int nCmdShow)'),
  keybd_event: user32.func('void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t extra)'),
  SHQueryUserNotificationState: shell32.func('long __stdcall SHQueryUserNotificationState(_Out_ int *pquns)'),
  OpenProcess: kernel32.func('void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)'),
  QueryFullProcessImageNameW: kernel32.func(
    'bool __stdcall QueryFullProcessImageNameW(void *hProcess, uint32_t flags, void *name, _Inout_ uint32_t *size)',
  ),
  CloseHandle: kernel32.func('bool __stdcall CloseHandle(void *h)'),
}

const QUNS = {
  1: 'not-present',
  2: 'busy (fullscreen app)',
  3: 'd3d-fullscreen',
  4: 'presentation-mode',
  5: 'accepts-notifications',
  6: 'quiet-time',
  7: 'app (UWP fullscreen)',
}

const wstr = (call, hwnd) => {
  const buf = Buffer.alloc(1024)
  const len = call(hwnd, buf, 512)
  return buf.toString('utf16le', 0, Math.max(0, len) * 2)
}

function processName(hwnd) {
  const pid = [0]
  fn.GetWindowThreadProcessId(hwnd, pid)
  const handle = fn.OpenProcess(0x1000 /* QUERY_LIMITED_INFORMATION */, false, pid[0])
  if (!handle) return { pid: pid[0], exe: null }
  try {
    const buf = Buffer.alloc(2048)
    const size = [1024]
    const ok = fn.QueryFullProcessImageNameW(handle, 0, buf, size)
    const full = ok ? buf.toString('utf16le', 0, size[0] * 2) : ''
    return { pid: pid[0], exe: full.split('\\').pop() || null }
  } finally {
    fn.CloseHandle(handle)
  }
}

function describe(hwnd) {
  if (!hwnd) return null
  const rect = {}
  fn.GetWindowRect(hwnd, rect)
  const mi = { cbSize: koffi.sizeof(MONITORINFO), rcMonitor: {}, rcWork: {}, dwFlags: 0 }
  fn.GetMonitorInfoW(fn.MonitorFromWindow(hwnd, 2 /* NEAREST */), mi)
  const m = mi.rcMonitor
  const coversMonitor = rect.left <= m.left && rect.top <= m.top && rect.right >= m.right && rect.bottom >= m.bottom
  return {
    address: koffi.address(hwnd).toString(),
    title: wstr(fn.GetWindowTextW, hwnd),
    className: wstr(fn.GetClassNameW, hwnd),
    ...processName(hwnd),
    zoomed: fn.IsZoomed(hwnd),
    rect,
    monitor: m,
    coversMonitor,
  }
}

function notificationState() {
  const out = [0]
  const hr = fn.SHQueryUserNotificationState(out)
  return hr === 0 ? QUNS[out[0]] || `unknown(${out[0]})` : `error(${hr})`
}

/** Snapshot of what is in front and whether the notch should yield to it. */
function foregroundSnapshot(ownAddresses) {
  const hwnd = fn.GetForegroundWindow()
  const win = describe(hwnd)
  const quns = notificationState()
  const shellClasses = ['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']
  let verdict = 'normal'
  if (!win || ownAddresses.includes(win.address) || shellClasses.includes(win.className)) verdict = 'ignore'
  else if (/fullscreen|presentation|d3d|app \(/.test(quns) || win.coversMonitor) verdict = 'hidden'
  else if (win.zoomed) verdict = 'mini'
  return { verdict, quns, window: win }
}

function topLevelWindowsOf(exeName) {
  const found = []
  const cb = koffi.register((hwnd) => {
    if (fn.IsWindowVisible(hwnd)) {
      const p = processName(hwnd)
      const title = wstr(fn.GetWindowTextW, hwnd)
      if (p.exe && p.exe.toLowerCase() === exeName.toLowerCase() && title) found.push({ hwnd, title, ...p })
    }
    return true
  }, koffi.pointer(EnumWindowsProc))
  try {
    fn.EnumWindows(cb, 0)
  } finally {
    koffi.unregister(cb)
  }
  return found
}

/** Tries to bring a window to front. Windows only allows this in limited cases; we report what happened. */
function bringToFront(hwnd, { altTrick }) {
  if (fn.IsIconic(hwnd)) fn.ShowWindow(hwnd, 9 /* SW_RESTORE */)
  if (altTrick) {
    // Pressing Alt marks this process as having received input, which relaxes the foreground lock.
    fn.keybd_event(0x12, 0, 0, 0)
    fn.keybd_event(0x12, 0, 2 /* KEYUP */, 0)
  }
  const ok = fn.SetForegroundWindow(hwnd)
  const now = fn.GetForegroundWindow()
  return { setForegroundReturned: ok, isNowForeground: koffi.address(now) === koffi.address(hwnd) }
}

module.exports = { foregroundSnapshot, topLevelWindowsOf, bringToFront, describe, fn, koffi }
