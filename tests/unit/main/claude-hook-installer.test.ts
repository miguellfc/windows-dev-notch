import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createHookInstaller,
  hookStatus,
  planInstall,
  planUninstall,
} from '../../../src/main/claude/hook-installer'
import { readTextFile, writeFileAtomic } from '../../../src/main/services/fs-atomic'
import { HOOK_EVENT_NAMES } from '../../../src/shared/claude/hook-events'

const OPTS = { port: 47600, token: 'tok-1' }

const FOREIGN_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Notification',
  'Stop',
  'SubagentStop',
  'SessionEnd',
  'PreCompact',
  'SubagentStart',
  'StopFailure',
]

const coucouGroup = (event: string) => ({
  matcher: '*',
  hooks: [{ type: 'command', command: `node "C:/coucou/hook.js" ${event}`, timeout: 5 }],
})

const fixtureObject = () => ({
  theme: 'dark',
  enabledPlugins: { 'ecc@ecc': true, 'superpowers@x': false },
  hooks: Object.fromEntries(FOREIGN_EVENTS.map((e) => [e, [coucouGroup(e)]])),
  permissions: { allow: ['Bash(git status)'] },
})

const fixtureText = () => `${JSON.stringify(fixtureObject(), null, 2)}\n`

const ok = (result: ReturnType<typeof planInstall>) => {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`)
  return result
}

const parse = (text: string) => JSON.parse(text) as Record<string, unknown> & {
  hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>
}

const isOurs = (group: { hooks: Array<Record<string, unknown>> }) =>
  group.hooks.every((h) => h.type === 'http' && (h.headers as Record<string, string>)['x-notch-hook'] === '1')

describe('planInstall', () => {
  it('adds one marked group per event and leaves foreign groups and keys untouched', () => {
    const { next } = ok(planInstall(fixtureText(), OPTS))
    const result = parse(next)
    const original = fixtureObject()

    expect(Object.keys(result)).toEqual(Object.keys(original))
    expect(result.theme).toBe('dark')
    expect(result.enabledPlugins).toEqual(original.enabledPlugins)
    expect(result.permissions).toEqual(original.permissions)
    for (const event of FOREIGN_EVENTS) {
      expect(result.hooks[event]?.[0]).toEqual(coucouGroup(event))
    }
    for (const event of HOOK_EVENT_NAMES) {
      const ours = result.hooks[event]?.filter(isOurs) ?? []
      // PreToolUse also gets the AskUserQuestion group.
      expect(ours).toHaveLength(event === 'PreToolUse' ? 2 : 1)
    }
    // The original groups keep their position; ours are appended.
    expect(result.hooks.PreToolUse).toHaveLength(3)
    expect(result.hooks.PreToolUse![0]).toEqual(coucouGroup('PreToolUse'))
    expect(isOurs(result.hooks.PreToolUse![1]!)).toBe(true)
    expect(isOurs(result.hooks.PreToolUse![2]!)).toBe(true)
  })

  it('adds the AskUserQuestion group to PreToolUse, held on /hook/question for up to an hour', () => {
    const { next } = ok(planInstall(fixtureText(), OPTS))
    const result = parse(next)
    expect(result.hooks.PreToolUse![2]).toEqual({
      matcher: 'AskUserQuestion',
      hooks: [
        {
          type: 'http',
          url: 'http://127.0.0.1:47600/hook/question',
          headers: { 'x-notch-token': 'tok-1', 'x-notch-hook': '1' },
          timeout: 3600,
        },
      ],
    })
    for (const event of HOOK_EVENT_NAMES.filter((e) => e !== 'PreToolUse')) {
      expect(JSON.stringify(result.hooks[event])).not.toContain('/hook/question')
    }
  })

  it('the diff preview shows the AskUserQuestion group being added to an older install', () => {
    const older = parse(ok(planInstall(fixtureText(), OPTS)).next)
    older.hooks.PreToolUse = older.hooks.PreToolUse!.filter((g) => !('matcher' in g && g.matcher === 'AskUserQuestion'))
    const olderText = `${JSON.stringify(older, null, 2)}\n`
    expect(hookStatus(olderText, OPTS)).toBe('outdated')
    const { next, diff } = ok(planInstall(olderText, OPTS))
    const added = diff.filter((l) => l.kind === 'add').map((l) => l.text)
    expect(added.some((t) => t.includes('"matcher": "AskUserQuestion"'))).toBe(true)
    expect(added.some((t) => t.includes('/hook/question'))).toBe(true)
    expect(diff.some((l) => l.kind === 'remove')).toBe(false)
    expect(hookStatus(next, OPTS)).toBe('installed')
  })

  it('writes the exact group shape, with a long timeout only for PermissionRequest', () => {
    const { next } = ok(planInstall(fixtureText(), OPTS))
    const result = parse(next)
    for (const event of HOOK_EVENT_NAMES) {
      const group = result.hooks[event]!.find(isOurs)!
      expect(group).toEqual({
        hooks: [
          {
            type: 'http',
            url: 'http://127.0.0.1:47600/hook',
            headers: { 'x-notch-token': 'tok-1', 'x-notch-hook': '1' },
            timeout: event === 'PermissionRequest' ? 3600 : 2,
          },
        ],
      })
    }
  })

  it('formats as 2-space JSON with a trailing newline', () => {
    const { next } = ok(planInstall(fixtureText(), OPTS))
    expect(next).toBe(`${JSON.stringify(JSON.parse(next), null, 2)}\n`)
  })

  it('is idempotent', () => {
    const first = ok(planInstall(fixtureText(), OPTS)).next
    const second = ok(planInstall(first, OPTS)).next
    expect(second).toBe(first)
  })

  it('replaces only our groups when reinstalling with a new token or port', () => {
    const first = ok(planInstall(fixtureText(), OPTS)).next
    const { next } = ok(planInstall(first, { port: 47601, token: 'tok-2' }))
    const result = parse(next)
    for (const event of HOOK_EVENT_NAMES) {
      const ours = result.hooks[event]!.filter(isOurs)
      expect(ours).toHaveLength(event === 'PreToolUse' ? 2 : 1)
      for (const group of ours) {
        expect(JSON.stringify(group)).toContain('tok-2')
        expect(JSON.stringify(group)).toContain('127.0.0.1:47601')
        expect(JSON.stringify(group)).not.toContain('tok-1')
      }
    }
    for (const event of FOREIGN_EVENTS) expect(result.hooks[event]![0]).toEqual(coucouGroup(event))
  })

  it('creates the hooks block when the file is missing', () => {
    const { next } = ok(planInstall(null, OPTS))
    const result = parse(next)
    expect(Object.keys(result)).toEqual(['hooks'])
    expect(Object.keys(result.hooks).sort()).toEqual([...HOOK_EVENT_NAMES].sort())
  })

  it('adds the hooks key to a file that has none', () => {
    const { next } = ok(planInstall('{ "theme": "dark" }', OPTS))
    expect(Object.keys(JSON.parse(next) as object)).toEqual(['theme', 'hooks'])
  })

  it('keeps CRLF line endings when the file used them', () => {
    const crlf = fixtureText().replace(/\n/g, '\r\n')
    const { next } = ok(planInstall(crlf, OPTS))
    expect(next.includes('\r\n')).toBe(true)
    expect(next.replace(/\r\n/g, '').includes('\n')).toBe(false)
  })

  it.each([
    ['not json', '{ nope'],
    ['empty', ''],
    ['BOM', `\uFEFF${fixtureText()}`],
    ['array', '[]'],
    ['primitive', '42'],
    ['null', 'null'],
    ['hooks not an object', '{ "hooks": [] }'],
    ['event not an array', '{ "hooks": { "Stop": {} } }'],
  ])('rejects %s as invalid-json', (_name, text) => {
    expect(planInstall(text, OPTS)).toEqual({ ok: false, reason: 'invalid-json' })
  })

  it('diff lists added lines and keeps context lines as same', () => {
    const result = ok(planInstall('{ "theme": "dark" }', OPTS))
    expect(result.diff.some((l) => l.kind === 'add' && l.text.includes('x-notch-hook'))).toBe(true)
    expect(result.diff.some((l) => l.kind === 'remove' && l.text.includes('theme'))).toBe(true)
    const same = ok(planInstall(ok(planInstall(null, OPTS)).next, OPTS)).diff
    expect(same.every((l) => l.kind === 'same')).toBe(true)
  })

  it('diff reports removed lines when the token is replaced', () => {
    const first = ok(planInstall(fixtureText(), OPTS)).next
    const { diff } = ok(planInstall(first, { ...OPTS, token: 'tok-2' }))
    expect(diff.filter((l) => l.kind === 'remove').some((l) => l.text.includes('tok-1'))).toBe(true)
    expect(diff.filter((l) => l.kind === 'add').some((l) => l.text.includes('tok-2'))).toBe(true)
  })
})

describe('planUninstall', () => {
  it('removes only our groups', () => {
    const installed = ok(planInstall(fixtureText(), OPTS)).next
    const edited = parse(installed)
    edited.theme = 'light'
    const { next } = ok(planUninstall(`${JSON.stringify(edited, null, 2)}\n`))
    const result = parse(next)
    expect(result.theme).toBe('light')
    for (const event of FOREIGN_EVENTS) expect(result.hooks[event]).toEqual([coucouGroup(event)])
    expect(JSON.stringify(result)).not.toContain('x-notch-hook')
    // Events that only existed because of us are gone.
    expect(result.hooks.PermissionDenied).toBeUndefined()
  })

  it('drops the hooks key when we created it and it ends up empty', () => {
    const installed = ok(planInstall('{ "theme": "dark" }', OPTS)).next
    expect(JSON.parse(ok(planUninstall(installed)).next)).toEqual({ theme: 'dark' })
  })

  it('returns the stored original text byte for byte when nothing else changed', () => {
    const original = '{\r\n\t"theme":"dark",\r\n\t"hooks": {}\r\n}'
    const installed = ok(planInstall(original, OPTS)).next
    expect(ok(planUninstall(installed, original)).next).toBe(original)
  })

  it('keeps an empty hooks object that existed in the original', () => {
    const original = '{ "hooks": {} }'
    const installed = ok(planInstall(original, OPTS)).next
    const { next } = ok(planUninstall(installed, '{ "hooks": { "Stop": [] } }'))
    expect(JSON.parse(next)).toEqual({ hooks: { Stop: [] } })
  })

  it('does not restore the original when other changes happened meanwhile', () => {
    const original = fixtureText()
    const installed = parse(ok(planInstall(original, OPTS)).next)
    installed.theme = 'light'
    const { next } = ok(planUninstall(JSON.stringify(installed, null, 2), original))
    expect(parse(next).theme).toBe('light')
    expect(next).not.toBe(original)
  })

  it('leaves the text unchanged when nothing of ours is present', () => {
    const { next, diff } = ok(planUninstall(fixtureText()))
    expect(next).toBe(fixtureText())
    expect(diff.every((l) => l.kind === 'same')).toBe(true)
  })

  it('rejects invalid JSON', () => {
    expect(planUninstall('{ nope')).toEqual({ ok: false, reason: 'invalid-json' })
    expect(planUninstall(`\uFEFF${fixtureText()}`)).toEqual({ ok: false, reason: 'invalid-json' })
  })
})

describe('hookStatus', () => {
  it('is missing without our groups, for a missing file and for garbage', () => {
    expect(hookStatus(null, OPTS)).toBe('missing')
    expect(hookStatus(fixtureText(), OPTS)).toBe('missing')
    expect(hookStatus('{ nope', OPTS)).toBe('missing')
  })

  it('is installed after install with the same port and token', () => {
    expect(hookStatus(ok(planInstall(fixtureText(), OPTS)).next, OPTS)).toBe('installed')
  })

  it('is outdated for a different token or port', () => {
    const installed = ok(planInstall(fixtureText(), OPTS)).next
    expect(hookStatus(installed, { ...OPTS, token: 'other' })).toBe('outdated')
    expect(hookStatus(installed, { ...OPTS, port: 1234 })).toBe('outdated')
  })

  it('is outdated when an event is missing or a timeout differs', () => {
    const installed = parse(ok(planInstall(fixtureText(), OPTS)).next)
    const withoutStop = structuredClone(installed)
    withoutStop.hooks.Stop = withoutStop.hooks.Stop!.filter((g) => !isOurs(g))
    expect(hookStatus(JSON.stringify(withoutStop), OPTS)).toBe('outdated')

    const badTimeout = structuredClone(installed)
    badTimeout.hooks.PermissionRequest!.find(isOurs)!.hooks[0]!.timeout = 2
    expect(hookStatus(JSON.stringify(badTimeout), OPTS)).toBe('outdated')
  })

  it('is outdated when the AskUserQuestion group is missing, changed or duplicated', () => {
    const installed = parse(ok(planInstall(fixtureText(), OPTS)).next)
    const isQuestion = (g: object) => 'matcher' in g && g.matcher === 'AskUserQuestion'

    const without = structuredClone(installed)
    without.hooks.PreToolUse = without.hooks.PreToolUse!.filter((g) => !isQuestion(g))
    expect(hookStatus(JSON.stringify(without), OPTS)).toBe('outdated')

    const shortTimeout = structuredClone(installed)
    shortTimeout.hooks.PreToolUse!.find(isQuestion)!.hooks[0]!.timeout = 2
    expect(hookStatus(JSON.stringify(shortTimeout), OPTS)).toBe('outdated')

    const wrongUrl = structuredClone(installed)
    wrongUrl.hooks.PreToolUse!.find(isQuestion)!.hooks[0]!.url = 'http://127.0.0.1:47600/hook'
    expect(hookStatus(JSON.stringify(wrongUrl), OPTS)).toBe('outdated')

    const twice = structuredClone(installed)
    twice.hooks.PreToolUse!.push(structuredClone(twice.hooks.PreToolUse!.find(isQuestion)!))
    expect(hookStatus(JSON.stringify(twice), OPTS)).toBe('outdated')
  })

  it('a foreign AskUserQuestion group does not count as ours and is kept on install and uninstall', () => {
    const foreign = { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: 'other-app ask' }] }
    const settings = fixtureObject()
    settings.hooks.PreToolUse = [...settings.hooks.PreToolUse!, foreign as never]
    const text = `${JSON.stringify(settings, null, 2)}\n`
    const installed = ok(planInstall(text, OPTS)).next
    expect(hookStatus(installed, OPTS)).toBe('installed')
    expect(parse(installed).hooks.PreToolUse!.slice(0, 2)).toEqual([coucouGroup('PreToolUse'), foreign])
    const removed = parse(ok(planUninstall(installed)).next)
    expect(removed.hooks.PreToolUse).toEqual([coucouGroup('PreToolUse'), foreign])
  })
})

describe('createHookInstaller', () => {
  let dir: string
  let file: string
  let backupDir: string
  const now = () => new Date(2026, 10, 10, 9, 5, 7)
  const make = () =>
    createHookInstaller({ file, readFile: readTextFile, writeFileAtomic, backupDir, now })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'notch-hook-installer-'))
    file = join(dir, '.claude', 'settings.json')
    backupDir = join(dir, 'backups')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const seed = async (text: string) => {
    await writeFileAtomic(file, text)
  }

  it('creates the file (and the .claude dir) when missing, with no backup', async () => {
    const installer = make()
    const result = await installer.install(OPTS)
    expect(result.ok).toBe(true)
    expect(Object.keys(parse(await readFile(file, 'utf8')))).toEqual(['hooks'])
    expect(await readdir(backupDir)).toEqual(['notch-hooks.original.json'])
    expect(await installer.status(OPTS)).toBe('installed')
  })

  it('backs up the previous text before writing, named by timestamp', async () => {
    const original = fixtureText()
    await seed(original)
    await make().install(OPTS)
    const files = await readdir(backupDir)
    expect(files).toContain('settings.backup-20261110-090507.json')
    expect(await readFile(join(backupDir, 'settings.backup-20261110-090507.json'), 'utf8')).toBe(original)
    expect(await readFile(file, 'utf8')).not.toBe(original)
  })

  it('uninstall right after install restores the exact original bytes', async () => {
    const original = '{\r\n\t"theme":"dark",\r\n\t"hooks":{"Stop":[{"hooks":[{"type":"command","command":"x"}]}]}\r\n}'
    await seed(original)
    const installer = make()
    await installer.install(OPTS)
    expect(await installer.status(OPTS)).toBe('installed')
    const result = await installer.uninstall()
    expect(result.ok).toBe(true)
    expect(await readFile(file, 'utf8')).toBe(original)
    expect(await installer.status(OPTS)).toBe('missing')
  })

  it('uninstall after other edits removes only our groups', async () => {
    await seed(fixtureText())
    const installer = make()
    await installer.install(OPTS)
    const edited = parse(await readFile(file, 'utf8'))
    edited.theme = 'light'
    await writeFile(file, JSON.stringify(edited, null, 2), 'utf8')
    await installer.uninstall()
    const result = parse(await readFile(file, 'utf8'))
    expect(result.theme).toBe('light')
    expect(JSON.stringify(result)).not.toContain('x-notch-hook')
    expect(result.hooks.Stop).toEqual([coucouGroup('Stop')])
  })

  it('does not overwrite the stored original when reinstalling', async () => {
    const original = fixtureText()
    await seed(original)
    const installer = make()
    await installer.install(OPTS)
    await installer.install({ ...OPTS, token: 'tok-2' })
    await installer.uninstall()
    expect(await readFile(file, 'utf8')).toBe(original)
  })

  it('refuses invalid JSON and writes nothing', async () => {
    await seed('{ nope')
    const installer = make()
    expect(await installer.install(OPTS)).toEqual({ ok: false, reason: 'invalid-json' })
    expect(await installer.uninstall()).toEqual({ ok: false, reason: 'invalid-json' })
    expect(await readFile(file, 'utf8')).toBe('{ nope')
    await expect(readdir(backupDir)).rejects.toThrow()
  })

  it('refuses a BOM file and writes nothing', async () => {
    await seed(`\uFEFF${fixtureText()}`)
    expect(await make().install(OPTS)).toEqual({ ok: false, reason: 'invalid-json' })
    expect(await readFile(file, 'utf8')).toBe(`\uFEFF${fixtureText()}`)
  })

  it('preview returns the diff without touching disk', async () => {
    await seed(fixtureText())
    const preview = await make().preview(OPTS)
    expect(preview.ok && preview.diff.some((l) => l.kind === 'add')).toBe(true)
    expect(await readFile(file, 'utf8')).toBe(fixtureText())
    await expect(readdir(backupDir)).rejects.toThrow()
  })

  it('uninstall with nothing installed writes nothing', async () => {
    await seed(fixtureText())
    const result = await make().uninstall()
    expect(result).toMatchObject({ ok: true, changed: false })
    await expect(readdir(backupDir)).rejects.toThrow()
  })

  it('writes through a symlinked settings.json to the real file instead of replacing the link', async (context) => {
    const realDir = join(dir, 'dotfiles')
    const real = join(realDir, 'claude-settings.json')
    await mkdir(realDir, { recursive: true })
    await writeFile(real, fixtureText(), 'utf8')
    await mkdir(join(dir, '.claude'), { recursive: true })
    try {
      await symlink(real, file, 'file')
    } catch {
      // Creating symlinks on Windows needs Developer Mode or admin; the injected resolver test below covers the logic.
      context.skip()
      return
    }
    await make().install(OPTS)
    expect((await lstat(file)).isSymbolicLink()).toBe(true)
    expect(await readFile(real, 'utf8')).toContain('x-notch-hook')
  })

  it('resolves the settings path before reading and writing (injected realpath)', async () => {
    const real = join(dir, 'elsewhere', 'settings.json')
    await writeFileAtomic(real, fixtureText())
    const installer = createHookInstaller({
      file,
      readFile: readTextFile,
      writeFileAtomic,
      backupDir,
      now,
      realpath: async (path) => (path === file ? real : path),
    })
    await installer.install(OPTS)
    expect(await readFile(real, 'utf8')).toContain('x-notch-hook')
    expect(await readTextFile(file)).toBeNull()
    expect(await installer.status(OPTS)).toBe('installed')
    await installer.uninstall()
    expect(await readFile(real, 'utf8')).toBe(fixtureText())
  })

  it('names backups uniquely within the same second', async () => {
    await seed(fixtureText())
    const installer = make()
    await installer.install(OPTS)
    await installer.install({ ...OPTS, token: 'tok-2' })
    await installer.install({ ...OPTS, token: 'tok-3' })
    const backups = (await readdir(backupDir)).filter((f) => f.startsWith('settings.backup-')).sort()
    expect(backups).toEqual([
      'settings.backup-20261110-090507-2.json',
      'settings.backup-20261110-090507-3.json',
      'settings.backup-20261110-090507.json',
    ])
  })

  it('keeps only the 10 newest backups', async () => {
    await mkdir(backupDir, { recursive: true })
    for (let day = 1; day <= 12; day += 1) {
      await writeFile(join(backupDir, `settings.backup-202611${String(day).padStart(2, '0')}-080000.json`), '{}', 'utf8')
    }
    await writeFile(join(backupDir, 'settings.backup-20261109-080000-2.json'), '{}', 'utf8')
    await writeFile(join(backupDir, 'unrelated.txt'), 'keep me', 'utf8')
    await seed(fixtureText())
    await make().install(OPTS)
    const files = await readdir(backupDir)
    const backups = files.filter((f) => f.startsWith('settings.backup-')).sort()
    expect(backups).toHaveLength(10)
    // Newest first by timestamp then suffix: the 12th, the new 10th-09:05:07 one, 11th, 10th, ...
    expect(backups).toContain('settings.backup-20261110-090507.json')
    expect(backups).toContain('settings.backup-20261112-080000.json')
    expect(backups).toContain('settings.backup-20261109-080000-2.json')
    expect(backups).not.toContain('settings.backup-20261101-080000.json')
    expect(backups).not.toContain('settings.backup-20261104-080000.json')
    expect(backups).toContain('settings.backup-20261105-080000.json')
    expect(files).toContain('unrelated.txt')
    expect(files).toContain('notch-hooks.original.json')
  })

  it('leaves no temp files next to the settings file', async () => {
    await seed(fixtureText())
    await make().install(OPTS)
    expect(await readdir(join(dir, '.claude'))).toEqual(['settings.json'])
  })
})
