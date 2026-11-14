import { describe, expect, it, vi } from 'vitest'
import { type AppLauncherDeps, cleanEnv, createAppLauncher } from '../../../src/main/apps/app-launcher'

const HOME = 'C:\\Users\\Ana María'

const WT = 'C:\\Tools\\wt.exe'
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const PS5 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const FULL_ENV: NodeJS.ProcessEnv = {
  PATH: 'C:\\Tools;C:\\Program Files\\PowerShell\\7',
  SystemRoot: 'C:\\Windows',
  LOCALAPPDATA: 'C:\\Users\\Ana María\\AppData\\Local',
}

const setup = (
  opts: { env?: NodeJS.ProcessEnv; spawnResults?: boolean[]; times?: number[]; present?: string[] } = {},
) => {
  const openExternal = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined)
  const results = [...(opts.spawnResults ?? [])]
  const trySpawn = vi.fn<AppLauncherDeps['trySpawn']>(async () =>
    results.length > 0 ? (results.shift() as boolean) : true,
  )
  const times = [...(opts.times ?? [])]
  let last = 0
  const now = vi.fn(() => {
    if (times.length > 0) last = times.shift() as number
    return last
  })
  const env = opts.env ?? FULL_ENV
  const present = new Set((opts.present ?? [WT, PWSH]).map((p) => p.toLowerCase()))
  const exists = vi.fn((path: string) => present.has(path.toLowerCase()))
  const launcher = createAppLauncher({ openExternal, trySpawn, exists, homeDir: HOME, env, now })
  return { launcher, openExternal, trySpawn, now, exists }
}

describe('createAppLauncher', () => {
  it('claude abre claude://claude.ai/new', async () => {
    const { launcher, openExternal } = setup()
    expect(await launcher.open('claude')).toBe('desktop')
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith('claude://claude.ai/new')
  })

  it('claude cae al navegador si el protocolo falla', async () => {
    const a = setup()
    a.openExternal.mockRejectedValueOnce(new Error('no handler'))
    expect(await a.launcher.open('claude')).toBe('browser')
    expect(a.openExternal).toHaveBeenNthCalledWith(2, 'https://claude.ai/new')

    const b = setup()
    b.openExternal.mockRejectedValue(new Error('no'))
    expect(await b.launcher.open('claude')).toBe('failed')
    expect(b.openExternal).toHaveBeenCalledTimes(2)
  })

  const OPTS = { cwd: HOME, env: cleanEnv(FULL_ENV) }

  it('terminal lanza wt (ruta absoluta) con pwsh absoluto en la carpeta de usuario', async () => {
    const { launcher, trySpawn } = setup()
    expect(await launcher.open('terminal')).toBe('wt')
    expect(trySpawn).toHaveBeenCalledTimes(1)
    expect(trySpawn).toHaveBeenCalledWith(WT, ['-w', 'new', '-d', HOME, PWSH, '-NoLogo'], OPTS)
  })

  it('la ruta con espacios sigue siendo un solo argumento', async () => {
    const { launcher, trySpawn } = setup()
    await launcher.open('terminal')
    const args = trySpawn.mock.calls[0]?.[1] ?? []
    expect(args[args.indexOf('-d') + 1]).toBe(HOME)
    expect(args).toHaveLength(6)
  })

  it('usa el alias de WindowsApps si no está en PATH', async () => {
    const alias = 'C:\\Users\\Ana María\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe'
    const { launcher, trySpawn } = setup({ present: [alias, PWSH] })
    expect(await launcher.open('terminal')).toBe('wt')
    expect(trySpawn.mock.calls[0]?.[0]).toBe(alias)
  })

  it('una entrada relativa de PATH nunca gana', async () => {
    const { launcher, trySpawn, exists } = setup({
      env: { PATH: '.;bin;..\\x;C:\\Tools', SystemRoot: 'C:\\Windows' },
      present: ['.\\wt.exe', 'bin\\wt.exe', WT],
    })
    expect(await launcher.open('terminal')).toBe('wt')
    expect(trySpawn.mock.calls[0]?.[0]).toBe(WT)
    for (const [path] of exists.mock.calls) expect(path).toMatch(/^[a-z]:\\/i)
  })

  it('sin wt lanza pwsh absoluto; sin pwsh, wt usa powershell.exe absoluto', async () => {
    const a = setup({ present: [PWSH] })
    expect(await a.launcher.open('terminal')).toBe('pwsh')
    expect(a.trySpawn).toHaveBeenCalledWith(PWSH, ['-NoLogo'], OPTS)

    const b = setup({ present: [WT] })
    expect(await b.launcher.open('terminal')).toBe('wt')
    expect(b.trySpawn).toHaveBeenCalledWith(WT, ['-w', 'new', '-d', HOME, PS5, '-NoLogo'], OPTS)
  })

  it('terminal cae a pwsh y luego a powershell si el arranque falla', async () => {
    const a = setup({ spawnResults: [false, true] })
    expect(await a.launcher.open('terminal')).toBe('pwsh')
    expect(a.trySpawn).toHaveBeenLastCalledWith(PWSH, ['-NoLogo'], OPTS)

    const b = setup({ spawnResults: [false, false, true] })
    expect(await b.launcher.open('terminal')).toBe('powershell')
    expect(b.trySpawn).toHaveBeenLastCalledWith(PS5, ['-NoLogo'], OPTS)

    const c = setup({ spawnResults: [false, false, false] })
    expect(await c.launcher.open('terminal')).toBe('failed')
    expect(c.trySpawn).toHaveBeenCalledTimes(3)
  })

  it('nada resoluble: falla sin lanzar nombres sueltos', async () => {
    const { launcher, trySpawn } = setup({ env: { PATH: '.;bin' }, present: [] })
    expect(await launcher.open('terminal')).toBe('failed')
    expect(trySpawn).not.toHaveBeenCalled()
  })

  it('SystemRoot relativo no sirve para powershell.exe', async () => {
    const { launcher, trySpawn } = setup({ env: { PATH: 'C:\\Tools', SystemRoot: 'win' }, present: [] })
    expect(await launcher.open('terminal')).toBe('failed')
    expect(trySpawn).not.toHaveBeenCalled()
  })

  it('el entorno no lleva NOTCH_ ni ELECTRON_', async () => {
    const { launcher, trySpawn } = setup({
      env: { ...FULL_ENV, NOTCH_USER_DATA_DIR: 'a', ELECTRON_RUN_AS_NODE: '1' },
    })
    await launcher.open('terminal')
    expect(trySpawn.mock.calls[0]?.[2].env).toEqual(cleanEnv(FULL_ENV))
    expect(cleanEnv({ NOTCH_A: '1', ELECTRON_B: '1', Z: '2' })).toEqual({ Z: '2' })
  })

  it('ignora un segundo clic de la misma app en < 1000 ms', async () => {
    const { launcher, openExternal, trySpawn } = setup({ times: [0, 999, 1000, 1001] })
    expect(await launcher.open('claude')).toBe('desktop')
    expect(await launcher.open('claude')).toBe('ignored')
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(await launcher.open('claude')).toBe('desktop')
    expect(openExternal).toHaveBeenCalledTimes(2)
    expect(await launcher.open('terminal')).toBe('wt')
    expect(trySpawn).toHaveBeenCalledTimes(1)
  })

  it('cuenta un intento fallido como lanzamiento reciente', async () => {
    const { launcher, openExternal } = setup({ times: [0, 10, 20, 30] })
    openExternal.mockRejectedValue(new Error('no'))
    expect(await launcher.open('claude')).toBe('failed')
    expect(await launcher.open('claude')).toBe('ignored')
  })

  it('ignora un clic mientras el primer lanzamiento sigue pendiente', async () => {
    const { launcher, openExternal } = setup({ times: [0, 10] })
    let release: () => void = () => undefined
    openExternal.mockReturnValueOnce(new Promise<void>((resolve) => (release = resolve)))
    const first = launcher.open('claude')
    expect(await launcher.open('claude')).toBe('ignored')
    expect(openExternal).toHaveBeenCalledTimes(1)
    release()
    expect(await first).toBe('desktop')
  })
})
