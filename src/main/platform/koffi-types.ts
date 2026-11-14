type Koffi = typeof import('koffi')

/** Returns the named koffi type if already registered in this process, else defines it once. */
export function ensureKoffiType(koffi: Koffi, name: string, define: () => unknown): void {
  try {
    koffi.type(name)
    return
  } catch {
    // not registered yet
  }
  define()
}

/** Global HWND handle type, shared by every Win32 binding in the process. */
export function ensureHwndType(koffi: Koffi): void {
  ensureKoffiType(koffi, 'HWND', () => koffi.pointer('HWND', koffi.opaque()))
}
