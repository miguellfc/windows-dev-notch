import { lstatSync } from 'node:fs'
import { win32 } from 'node:path'

/**
 * True when something exists at `path`. Uses lstat, not stat: the WindowsApps `pwsh.exe` is an
 * App Execution Alias (a reparse point) that `existsSync` reports as missing.
 */
export function pathExists(path: string, lstat: (path: string) => unknown = lstatSync): boolean {
  try {
    lstat(path)
    return true
  } catch {
    return false
  }
}

export interface ShellResolverDeps {
  exists: (path: string) => boolean
  env: Readonly<Record<string, string | undefined>>
}

const envValue = (env: ShellResolverDeps['env'], name: string): string | undefined => {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : env[key]
}

const DRIVE_PATH = /^[a-z]:\\/i

/** Variables that would change how Electron, Node or this app behave if a child inherited them. */
const PRIVATE_VARIABLE = /^(ELECTRON_|NODE_OPTIONS$|NOTCH_)/i

/** The environment the shell starts with: the user's, minus our own runtime switches. */
export function shellEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !PRIVATE_VARIABLE.test(entry[0]),
    ),
  )
}

/**
 * Picks the shell for the embedded terminal: PowerShell 7 when installed (PATH or its
 * WindowsApps alias), otherwise Windows PowerShell 5.1, which ships with Windows.
 * Only absolute drive locations are considered, so a relative PATH entry can never win.
 */
export function resolveShell({ exists, env }: ShellResolverDeps): string {
  const candidates = (envValue(env, 'PATH') ?? '')
    .split(';')
    .map((dir) => dir.trim())
    .filter((dir) => DRIVE_PATH.test(dir))
    .map((dir) => win32.join(dir, 'pwsh.exe'))

  const localAppData = envValue(env, 'LOCALAPPDATA')
  if (localAppData && DRIVE_PATH.test(localAppData)) {
    candidates.push(win32.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe'))
  }

  const found = candidates.find((candidate) => exists(candidate))
  if (found) return found

  const systemRoot = envValue(env, 'SystemRoot')
  const root = systemRoot && DRIVE_PATH.test(systemRoot) ? systemRoot : 'C:\\Windows'
  return win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}
