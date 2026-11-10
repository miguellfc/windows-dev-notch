import path from 'node:path'
import type { Logger } from '../services/logger'
import { ensureHwndType, ensureKoffiType } from '../platform/koffi-types'

export type BringToFrontResult = 'focused' | 'not-running' | 'blocked'

export interface Win32FocusApi {
  /** Visible top-level window with a non-empty title owned by claude.exe, or null. */
  findClaudeWindow(): unknown | null
  getForegroundWindow(): unknown
  sameWindow(a: unknown, b: unknown): boolean
  getWindowThreadId(hwnd: unknown): number
  getCurrentThreadId(): number
  attachThreadInput(from: number, to: number, attach: boolean): boolean
  isIconic(hwnd: unknown): boolean
  restoreWindow(hwnd: unknown): void
  bringWindowToTop(hwnd: unknown): void
  setForegroundWindow(hwnd: unknown): void
}

/** Sequence validated in the M3 spike. */
export function bringClaudeToFront(api: Win32FocusApi): BringToFrontResult {
  const target = api.findClaudeWindow()
  if (!target) return 'not-running'

  const foreground = api.getForegroundWindow()
  const foregroundThread = foreground ? api.getWindowThreadId(foreground) : 0
  const me = api.getCurrentThreadId()
  const attached = foregroundThread !== 0 && api.attachThreadInput(me, foregroundThread, true)
  try {
    if (api.isIconic(target)) api.restoreWindow(target)
    api.bringWindowToTop(target)
    api.setForegroundWindow(target)
  } finally {
    if (attached) api.attachThreadInput(me, foregroundThread, false)
  }
  return api.sameWindow(api.getForegroundWindow(), target) ? 'focused' : 'blocked'
}

/** koffi adapter. Returns null when koffi cannot load. Not unit-tested; keep thin. */
export function createWin32FocusApi(logger: Logger): Win32FocusApi | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as typeof import('koffi')
    const user32 = koffi.load('user32.dll')
    const kernel32 = koffi.load('kernel32.dll')

    ensureHwndType(koffi)
    ensureKoffiType(koffi, 'NOTCH_ENUMPROC', () => koffi.proto('bool __stdcall NOTCH_ENUMPROC(HWND hwnd, intptr_t lParam)'))
    const EnumWindowsProc = koffi.type('NOTCH_ENUMPROC')

    const EnumWindows = user32.func('bool __stdcall EnumWindows(NOTCH_ENUMPROC *cb, intptr_t lParam)')
    const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(HWND hWnd)')
    const GetWindowTextLengthW = user32.func('int __stdcall GetWindowTextLengthW(HWND hWnd)')
    const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(HWND hWnd, _Out_ uint32_t *pid)')
    const GetForegroundWindow = user32.func('HWND __stdcall GetForegroundWindow()')
    const AttachThreadInput = user32.func('bool __stdcall AttachThreadInput(uint32_t idAttach, uint32_t idAttachTo, bool fAttach)')
    const IsIconic = user32.func('bool __stdcall IsIconic(HWND hWnd)')
    const ShowWindow = user32.func('bool __stdcall ShowWindow(HWND hWnd, int nCmdShow)')
    const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(HWND hWnd)')
    const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(HWND hWnd)')
    const GetCurrentThreadId = kernel32.func('uint32_t __stdcall GetCurrentThreadId()')
    const OpenProcess = kernel32.func('void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)')
    const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *handle)')
    const QueryFullProcessImageNameW = kernel32.func(
      'bool __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, void *name, _Inout_ uint32_t *size)',
    )

    const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    const SW_RESTORE = 9

    const imageBasename = (hwnd: unknown): string => {
      const pid = [0]
      GetWindowThreadProcessId(hwnd, pid)
      if (!pid[0]) return ''
      const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid[0])
      if (!handle) return ''
      try {
        const buffer = Buffer.alloc(2048)
        const size = [1024]
        if (!QueryFullProcessImageNameW(handle, 0, buffer, size)) return ''
        return path.win32.basename(buffer.toString('utf16le', 0, (size[0] ?? 0) * 2)).toLowerCase()
      } finally {
        CloseHandle(handle)
      }
    }

    return {
      findClaudeWindow() {
        let found: unknown = null
        const callback = koffi.register((hwnd: unknown) => {
          try {
            if (IsWindowVisible(hwnd) && (GetWindowTextLengthW(hwnd) as number) > 0 && imageBasename(hwnd) === 'claude.exe') {
              found = hwnd
              return false
            }
          } catch {
            // never let an exception cross into native code
          }
          return true
        }, koffi.pointer(EnumWindowsProc))
        try {
          EnumWindows(callback, 0)
        } finally {
          koffi.unregister(callback)
        }
        return found
      },
      getForegroundWindow: () => GetForegroundWindow(),
      sameWindow: (a, b) => Boolean(a) && Boolean(b) && koffi.address(a) === koffi.address(b),
      getWindowThreadId: (hwnd) => GetWindowThreadProcessId(hwnd, [0]) as number,
      getCurrentThreadId: () => GetCurrentThreadId() as number,
      attachThreadInput: (from, to, attach) => Boolean(AttachThreadInput(from, to, attach)),
      isIconic: (hwnd) => Boolean(IsIconic(hwnd)),
      restoreWindow: (hwnd) => {
        ShowWindow(hwnd, SW_RESTORE)
      },
      bringWindowToTop: (hwnd) => {
        BringWindowToTop(hwnd)
      },
      setForegroundWindow: (hwnd) => {
        SetForegroundWindow(hwnd)
      },
    }
  } catch (error) {
    logger.child('claude-focus').error('Win32 focus bindings unavailable; bring-to-front disabled', { error })
    return null
  }
}
