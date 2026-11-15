import { spawn } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { win32 } from 'node:path'

export type AppId = 'claude' | 'terminal'
export type LaunchResult = 'desktop' | 'browser' | 'wt' | 'pwsh' | 'powershell' | 'failed' | 'ignored'

export interface AppLauncherDeps {
  openExternal(url: string): Promise<void>
  /** Resolves true on the child's 'spawn' event, false on 'error'; detaches and unrefs on success. */
  trySpawn(file: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<boolean>
  /** True when something exists at the absolute path (lstat: WindowsApps aliases are reparse points). */
  exists(path: string): boolean
  homeDir: string
  env: NodeJS.ProcessEnv
  now(): number
}

const CLAUDE_URL = 'claude://claude.ai/new'
const CLAUDE_WEB_URL = 'https://claude.ai/new'
const DOUBLE_CLICK_MS = 1000

export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('NOTCH_') || key.startsWith('ELECTRON_')) continue
    out[key] = value
  }
  return out
}

/** lstat, not stat: the WindowsApps `wt.exe`/`pwsh.exe` are App Execution Aliases that existsSync reports missing. */
export function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

const DRIVE_PATH = /^[a-z]:\\/i

const envValue = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : env[key]
}

/**
 * Absolute path of `exe`: PATH entries in order, then the WindowsApps alias. Only absolute drive
 * locations count, so a relative PATH entry (or the child's cwd) can never win the lookup.
 */
export function resolveExecutable(exe: string, env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string | undefined {
  const candidates = (envValue(env, 'PATH') ?? '')
    .split(';')
    .map((dir) => dir.trim())
    .filter((dir) => DRIVE_PATH.test(dir))
    .map((dir) => win32.join(dir, exe))
  const localAppData = envValue(env, 'LOCALAPPDATA')
  if (localAppData && DRIVE_PATH.test(localAppData)) {
    candidates.push(win32.join(localAppData, 'Microsoft', 'WindowsApps', exe))
  }
  return candidates.find((candidate) => exists(candidate))
}

function windowsPowerShell(env: NodeJS.ProcessEnv): string | undefined {
  const root = envValue(env, 'SystemRoot')
  return root && DRIVE_PATH.test(root) ? win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : undefined
}

export function createAppLauncher(deps: AppLauncherDeps): { open(app: AppId): Promise<LaunchResult> } {
  const lastAttempt = new Map<AppId, number>()

  const openClaude = async (): Promise<LaunchResult> => {
    try {
      await deps.openExternal(CLAUDE_URL)
      return 'desktop'
    } catch {
      try {
        await deps.openExternal(CLAUDE_WEB_URL)
        return 'browser'
      } catch {
        return 'failed'
      }
    }
  }

  const openTerminal = async (): Promise<LaunchResult> => {
    const options = { cwd: deps.homeDir, env: cleanEnv(deps.env) }
    const wt = resolveExecutable('wt.exe', deps.env, deps.exists)
    const pwsh = resolveExecutable('pwsh.exe', deps.env, deps.exists)
    const ps5 = windowsPowerShell(deps.env)
    const shell = pwsh ?? ps5
    const attempts: Array<readonly [string, readonly string[], LaunchResult]> = []
    if (wt && shell) attempts.push([wt, ['-w', 'new', '-d', deps.homeDir, shell, '-NoLogo'], 'wt'])
    if (pwsh) attempts.push([pwsh, ['-NoLogo'], 'pwsh'])
    if (ps5) attempts.push([ps5, ['-NoLogo'], 'powershell'])
    for (const [file, args, result] of attempts) {
      if (await deps.trySpawn(file, args, options)) return result
    }
    return 'failed'
  }

  return {
    async open(app) {
      const now = deps.now()
      const last = lastAttempt.get(app)
      if (last !== undefined && now - last < DOUBLE_CLICK_MS) return 'ignored'
      lastAttempt.set(app, now)
      return app === 'claude' ? openClaude() : openTerminal()
    },
  }
}

export function nodeTrySpawn(): AppLauncherDeps['trySpawn'] {
  return (file, args, { cwd, env }) =>
    new Promise<boolean>((resolve) => {
      try {
        const child = spawn(file, [...args], {
          cwd,
          env,
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
          shell: false,
        })
        child.once('spawn', () => {
          child.unref()
          resolve(true)
        })
        child.once('error', () => resolve(false))
      } catch {
        resolve(false)
      }
    })
}
