import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { pathExists, resolveShell, shellEnvironment } from '../../../src/main/terminal/shell-resolver'

const existing = (...paths: string[]) => {
  const set = new Set(paths.map((p) => p.toLowerCase()))
  return (path: string) => set.has(path.toLowerCase())
}

describe('resolveShell', () => {
  it('prefers PowerShell 7 found on PATH', () => {
    const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
    expect(resolveShell({ exists: existing(pwsh), env: { PATH: 'C:\\A;C:\\Program Files\\PowerShell\\7' } })).toBe(pwsh)
  })

  it('finds the WindowsApps alias of PowerShell 7', () => {
    const alias = 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe'
    expect(resolveShell({ exists: existing(alias), env: { PATH: 'C:\\A', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } })).toBe(
      alias,
    )
  })

  it('falls back to Windows PowerShell 5.1 under SystemRoot', () => {
    expect(resolveShell({ exists: existing(), env: { PATH: 'C:\\A', SystemRoot: 'C:\\WINDOWS' } })).toBe(
      'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
  })

  it('assumes C:\\Windows when SystemRoot is missing', () => {
    expect(resolveShell({ exists: existing(), env: {} })).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })

  it('ignores relative and empty PATH entries', () => {
    const seen: string[] = []
    const exists = (path: string) => {
      seen.push(path)
      return true
    }
    expect(resolveShell({ exists, env: { PATH: '.;;bin', SystemRoot: 'C:\\Windows' } })).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
    expect(seen).toEqual([])
  })

  it('reads Path regardless of its case', () => {
    const pwsh = 'D:\\Tools\\pwsh.exe'
    expect(resolveShell({ exists: existing(pwsh), env: { Path: 'D:\\Tools' } })).toBe(pwsh)
  })
})

describe('pathExists', () => {
  it('sees files, and missing paths as missing', () => {
    expect(pathExists(fileURLToPath(import.meta.url))).toBe(true)
    expect(pathExists(join(tmpdir(), 'notch-no-such-shell.exe'))).toBe(false)
  })

  it('counts a link as present even when stat cannot follow it (WindowsApps aliases)', () => {
    expect(pathExists('C:\\alias\\pwsh.exe', () => ({}))).toBe(true)
  })
})

describe('shellEnvironment', () => {
  it('passes the user environment but not Electron or Node switches', () => {
    expect(
      shellEnvironment({
        PATH: 'C:\\Windows',
        USERPROFILE: 'C:\\Users\\u',
        ELECTRON_RUN_AS_NODE: '1',
        ELECTRON_RENDERER_URL: 'http://localhost:5173',
        electron_enable_logging: '1',
        NODE_OPTIONS: '--require evil.js',
        NOTCH_USER_DATA_DIR: 'C:\\tmp',
        EMPTY: undefined,
      }),
    ).toEqual({ PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u' })
  })
})
