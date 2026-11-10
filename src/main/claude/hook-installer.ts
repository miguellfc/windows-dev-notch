import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile as fsReadFile, realpath as fsRealpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { HOOK_EVENT_NAMES } from '../../shared/claude/hook-events'

export type DiffLine = { kind: 'add' | 'remove' | 'same'; text: string }
export type HookInstallOptions = { port: number; token: string }
export type HookStatus = 'installed' | 'outdated' | 'missing'
export type InvalidJson = { ok: false; reason: 'invalid-json' }
export type HookPlan = { ok: true; next: string; diff: DiffLine[] } | InvalidJson

const HOOK_MARKER_HEADER = 'x-notch-hook'
const TOKEN_HEADER = 'x-notch-token'
const PERMISSION_TIMEOUT_SECONDS = 3600
const DEFAULT_TIMEOUT_SECONDS = 2

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isOurHook = (hook: unknown): boolean =>
  isRecord(hook) &&
  hook.type === 'http' &&
  isRecord(hook.headers) &&
  (hook.headers as Json)[HOOK_MARKER_HEADER] === '1'

/** A group is ours iff it has hooks and every one of them is one of ours. */
const isOurGroup = (group: unknown): boolean =>
  isRecord(group) && Array.isArray(group.hooks) && group.hooks.length > 0 && group.hooks.every(isOurHook)

const ourGroup = (event: string, { port, token }: HookInstallOptions): Json => ({
  hooks: [
    {
      type: 'http',
      url: `http://127.0.0.1:${port}/hook`,
      headers: { [TOKEN_HEADER]: token, [HOOK_MARKER_HEADER]: '1' },
      timeout: event === 'PermissionRequest' ? PERMISSION_TIMEOUT_SECONDS : DEFAULT_TIMEOUT_SECONDS,
    },
  ],
})

/**
 * Parses settings text into a top-level object whose `hooks` (when present) is an
 * object of arrays. Anything else (bad JSON, BOM, other shapes) is refused so we
 * never rewrite a file we do not fully understand.
 */
const parseSettings = (text: string): Json | null => {
  if (text.startsWith('﻿')) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  if ('hooks' in value) {
    if (!isRecord(value.hooks)) return null
    if (!Object.values(value.hooks).every(Array.isArray)) return null
  }
  return value
}

const lineEnding = (text: string | null): string => (text?.includes('\r\n') ? '\r\n' : '\n')

const serialize = (value: Json, eol: string): string => {
  const body = `${JSON.stringify(value, null, 2)}\n`
  return eol === '\n' ? body : body.replace(/\n/g, eol)
}

const splitLines = (text: string): string[] => {
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** Plain LCS line diff; settings files are small, so O(n*m) is fine. */
export const diffLines = (before: string, after: string): DiffLine[] => {
  const a = splitLines(before)
  const b = splitLines(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const table: number[][] = Array.from({ length: midA.length + 1 }, () => new Array<number>(midB.length + 1).fill(0))
  for (let i = midA.length - 1; i >= 0; i -= 1) {
    for (let j = midB.length - 1; j >= 0; j -= 1) {
      table[i]![j] = midA[i] === midB[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  const out: DiffLine[] = a.slice(0, start).map((text) => ({ kind: 'same', text }))
  let i = 0
  let j = 0
  while (i < midA.length || j < midB.length) {
    if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
      out.push({ kind: 'same', text: midA[i]! })
      i += 1
      j += 1
    } else if (j < midB.length && (i === midA.length || table[i]![j + 1]! >= table[i + 1]![j]!)) {
      out.push({ kind: 'add', text: midB[j]! })
      j += 1
    } else {
      out.push({ kind: 'remove', text: midA[i]! })
      i += 1
    }
  }
  for (const text of a.slice(endA)) out.push({ kind: 'same', text })
  return out
}

/**
 * Returns `settings` without any group of ours. Event arrays (and `hooks`) that we
 * emptied are dropped unless `keep` says they already existed in the original.
 */
const withoutOurs = (settings: Json, original: Json | null): { value: Json; removed: boolean } => {
  if (!isRecord(settings.hooks)) return { value: settings, removed: false }
  const originalHooks = original && isRecord(original.hooks) ? original.hooks : null
  const hooks: Json = {}
  let removed = false
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const list = groups as unknown[]
    const kept = list.filter((group) => !isOurGroup(group))
    if (kept.length === list.length) {
      hooks[event] = groups
      continue
    }
    removed = true
    if (kept.length > 0 || (originalHooks !== null && event in originalHooks)) hooks[event] = kept
  }
  if (!removed) return { value: settings, removed: false }
  const value: Json = {}
  for (const [key, entry] of Object.entries(settings)) {
    if (key !== 'hooks') value[key] = entry
    else if (Object.keys(hooks).length > 0 || (original !== null && 'hooks' in original)) value[key] = hooks
  }
  return { value, removed: true }
}

export const planInstall = (current: string | null, options: HookInstallOptions): HookPlan => {
  const settings = current === null ? {} : parseSettings(current)
  if (settings === null) return { ok: false, reason: 'invalid-json' }
  const hooks: Json = {}
  for (const [event, groups] of Object.entries(isRecord(settings.hooks) ? settings.hooks : {})) {
    const list = groups as unknown[]
    const kept = list.filter((group) => !isOurGroup(group))
    // An event key that only held our (stale) groups is rebuilt below or dropped.
    if (kept.length > 0 || kept.length === list.length) hooks[event] = kept
  }
  for (const event of HOOK_EVENT_NAMES) {
    const existing = hooks[event]
    hooks[event] = [...(Array.isArray(existing) ? existing : []), ourGroup(event, options)]
  }
  const next: Json = {}
  for (const [key, entry] of Object.entries(settings)) next[key] = key === 'hooks' ? hooks : entry
  if (!('hooks' in next)) next.hooks = hooks
  const text = serialize(next, lineEnding(current))
  return { ok: true, next: text, diff: diffLines(current ?? '', text) }
}

/**
 * `original` is the exact pre-install text. When removing our groups yields JSON
 * equal to it, that text is returned byte for byte.
 */
export const planUninstall = (current: string, original?: string | null): HookPlan => {
  const settings = parseSettings(current)
  if (settings === null) return { ok: false, reason: 'invalid-json' }
  const originalSettings = typeof original === 'string' ? parseSettings(original) : null
  const { value, removed } = withoutOurs(settings, originalSettings)
  if (!removed) return { ok: true, next: current, diff: diffLines(current, current) }
  const next =
    typeof original === 'string' && originalSettings !== null && isDeepStrictEqual(value, originalSettings)
      ? original
      : serialize(value, lineEnding(current))
  return { ok: true, next, diff: diffLines(current, next) }
}

export const hookStatus = (current: string | null, options: HookInstallOptions): HookStatus => {
  const settings = current === null ? null : parseSettings(current)
  if (settings === null || !isRecord(settings.hooks)) return 'missing'
  let anyOurs = false
  let allExact = true
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const ours = (groups as unknown[]).filter(isOurGroup)
    if (ours.length > 0) anyOurs = true
    const expected = (HOOK_EVENT_NAMES as readonly string[]).includes(event)
    if (expected ? ours.length !== 1 || !isDeepStrictEqual(ours[0], ourGroup(event, options)) : ours.length > 0) {
      allExact = false
    }
  }
  if (!anyOurs) return 'missing'
  const covered = HOOK_EVENT_NAMES.every((event) => (settings.hooks as Json)[event] !== undefined)
  return allExact && covered ? 'installed' : 'outdated'
}

// --- Adapter ---------------------------------------------------------------

export type HookInstallerDeps = {
  file: string
  /** Resolves to null when the file does not exist. */
  readFile: (path: string) => Promise<string | null>
  writeFileAtomic: (path: string, text: string) => Promise<void>
  backupDir: string
  now: () => Date
  /** Resolves symlinks so we write the real file, not replace the link (default: fs.realpath; missing file = itself). */
  realpath?: (path: string) => Promise<string>
}

export type HookWriteResult =
  | { ok: true; changed: boolean; diff: DiffLine[]; backupFile?: string }
  | InvalidJson

export type HookInstaller = {
  preview: (options: HookInstallOptions) => Promise<HookPlan>
  install: (options: HookInstallOptions) => Promise<HookWriteResult>
  uninstall: () => Promise<HookWriteResult>
  status: (options: HookInstallOptions) => Promise<HookStatus>
}

const ORIGINAL_FILE = 'notch-hooks.original.json'
/** Older `settings.backup-*.json` files beyond this many are deleted. */
export const MAX_BACKUPS = 10
const BACKUP_NAME = /^settings\.backup-(\d{8}-\d{6})(?:-(\d+))?\.json$/

const pad = (n: number): string => String(n).padStart(2, '0')

const timestamp = (date: Date): string =>
  `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`

export const readTextFile = async (path: string): Promise<string | null> => {
  try {
    return await fsReadFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** The real path behind a (possibly symlinked) file; the path itself when it does not exist yet. */
export const resolveRealPath = async (path: string): Promise<string> => {
  try {
    return await fsRealpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path
    throw error
  }
}

/** Writes to a unique temp file in the same directory, then renames over the target. */
export const writeFileAtomic = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, text, 'utf8')
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

export const createHookInstaller = (deps: HookInstallerDeps): HookInstaller => {
  const originalPath = join(deps.backupDir, ORIGINAL_FILE)

  const target = (): Promise<string> => (deps.realpath ?? resolveRealPath)(deps.file)

  /** Deletes all but the MAX_BACKUPS newest backups (by timestamp, then same-second suffix). */
  const pruneBackups = async (): Promise<void> => {
    const backups = (await readdir(deps.backupDir))
      .map((name) => ({ name, match: BACKUP_NAME.exec(name) }))
      .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
      .map(({ name, match }) => ({ name, stamp: match[1]!, n: Number(match[2] ?? 1) }))
      .sort((a, b) => (a.stamp === b.stamp ? b.n - a.n : a.stamp < b.stamp ? 1 : -1))
    for (const old of backups.slice(MAX_BACKUPS)) await rm(join(deps.backupDir, old.name), { force: true })
  }

  const backup = async (current: string | null): Promise<string | undefined> => {
    if (current === null) return undefined
    const stamp = timestamp(deps.now())
    let path = join(deps.backupDir, `settings.backup-${stamp}.json`)
    // Several writes in the same second must not overwrite each other's backup.
    for (let n = 2; (await deps.readFile(path)) !== null; n += 1) {
      path = join(deps.backupDir, `settings.backup-${stamp}-${n}.json`)
    }
    await deps.writeFileAtomic(path, current)
    await pruneBackups()
    return path
  }

  return {
    preview: async (options) => planInstall(await deps.readFile(await target()), options),

    install: async (options) => {
      const file = await target()
      const current = await deps.readFile(file)
      const plan = planInstall(current, options)
      if (!plan.ok) return plan
      if (plan.next === current) return { ok: true, changed: false, diff: plan.diff }
      const backupFile = await backup(current)
      // Keep the pre-install text only while none of our groups exist yet; a
      // reinstall must not replace it with a file that already contains them.
      const alreadyOurs = current !== null && hookStatus(current, options) !== 'missing'
      if (!alreadyOurs || (await deps.readFile(originalPath)) === null) {
        await deps.writeFileAtomic(originalPath, current ?? '{}\n')
      }
      await deps.writeFileAtomic(file, plan.next)
      return { ok: true, changed: true, diff: plan.diff, ...(backupFile ? { backupFile } : {}) }
    },

    uninstall: async () => {
      const file = await target()
      const current = await deps.readFile(file)
      if (current === null) return { ok: true, changed: false, diff: [] }
      const plan = planUninstall(current, await deps.readFile(originalPath))
      if (!plan.ok) return plan
      if (plan.next === current) return { ok: true, changed: false, diff: plan.diff }
      const backupFile = await backup(current)
      await deps.writeFileAtomic(file, plan.next)
      return { ok: true, changed: true, diff: plan.diff, ...(backupFile ? { backupFile } : {}) }
    },

    status: async (options) => hookStatus(await deps.readFile(await target()), options),
  }
}
