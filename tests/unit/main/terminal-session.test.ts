import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTerminalSession, type PtyLike, type SpawnPty } from '../../../src/main/terminal/terminal-session'
import { createMemoryLogger } from '../helpers/memory-logger'

class FakePty implements PtyLike {
  readonly pid = 4242
  readonly written: string[] = []
  readonly sizes: [number, number][] = []
  readonly kill = vi.fn()
  private dataListener: ((data: string) => void) | undefined
  private exitListener: ((e: { exitCode: number }) => void) | undefined

  write(data: string) {
    this.written.push(data)
  }
  resize(cols: number, rows: number) {
    this.sizes.push([cols, rows])
  }
  onData(cb: (data: string) => void) {
    this.dataListener = cb
    return { dispose: () => (this.dataListener = undefined) }
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitListener = cb
    return { dispose: () => (this.exitListener = undefined) }
  }
  emitData(data: string) {
    this.dataListener?.(data)
  }
  emitExit(exitCode: number) {
    this.exitListener?.({ exitCode })
  }
}

const SHELL = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

function setup(options: { scrollbackBytes?: number; spawnError?: Error; isViewing?: () => boolean } = {}) {
  const ptys: FakePty[] = []
  const spawn = vi.fn<SpawnPty>(() => {
    if (options.spawnError) throw options.spawnError
    const pty = new FakePty()
    ptys.push(pty)
    return pty
  })
  const onData = vi.fn<(chunk: string) => void>()
  const onExit = vi.fn<(code: number) => void>()
  const logger = createMemoryLogger()
  const session = createTerminalSession({
    spawn,
    shell: SHELL,
    cwd: 'C:\\Users\\u',
    env: { PATH: 'C:\\Windows' },
    onData,
    onExit,
    logger,
    ...(options.scrollbackBytes === undefined ? {} : { scrollbackBytes: options.scrollbackBytes }),
    ...(options.isViewing === undefined ? {} : { isViewing: options.isViewing }),
  })
  return { session, spawn, ptys, onData, onExit, logger }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('terminal session', () => {
  it('starts the shell on first open with fixed arguments and reuses it afterwards', () => {
    const { session, spawn } = setup()
    expect(spawn).not.toHaveBeenCalled()
    expect(session.open()).toEqual({ state: 'running', snapshot: '', shell: SHELL })
    expect(spawn).toHaveBeenCalledWith(SHELL, ['-NoLogo'], {
      name: 'xterm-256color',
      cols: 100,
      rows: 20,
      cwd: 'C:\\Users\\u',
      env: { PATH: 'C:\\Windows' },
    })
    session.open()
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('ignores input and resizes until a session exists', () => {
    const { session, ptys } = setup()
    session.write('dir\r')
    session.resize(80, 24)
    session.open()
    expect(ptys[0]!.written).toEqual([])
    session.write('dir\r')
    session.resize(80, 24)
    expect(ptys[0]!.written).toEqual(['dir\r'])
    expect(ptys[0]!.sizes).toEqual([[80, 24]])
  })

  it('batches output before sending it to the renderer', () => {
    const { session, ptys, onData } = setup()
    session.open()
    ptys[0]!.emitData('a')
    ptys[0]!.emitData('b')
    expect(onData).not.toHaveBeenCalled()
    vi.advanceTimersByTime(8)
    expect(onData).toHaveBeenCalledExactlyOnceWith('ab')
  })

  it('keeps output only in the history while nobody is viewing the terminal', () => {
    let viewing = false
    const { session, ptys, onData } = setup({ isViewing: () => viewing })
    session.open()
    ptys[0]!.emitData('while closed')
    vi.advanceTimersByTime(8)
    expect(onData).not.toHaveBeenCalled()
    viewing = true
    expect(session.open().snapshot).toBe('while closed')
    ptys[0]!.emitData('live')
    vi.advanceTimersByTime(8)
    expect(onData).toHaveBeenCalledExactlyOnceWith('live')
  })

  it('replays earlier output when the view opens again', () => {
    const { session, ptys } = setup()
    session.open()
    ptys[0]!.emitData('PS C:\\> ')
    vi.advanceTimersByTime(8)
    expect(session.open()).toMatchObject({ state: 'running', snapshot: 'PS C:\\> ' })
  })

  it('sends pending output before taking a snapshot, so the view never sees it twice', () => {
    const { session, ptys, onData } = setup()
    session.open()
    ptys[0]!.emitData('late')
    expect(session.open().snapshot).toBe('late')
    expect(onData).toHaveBeenCalledExactlyOnceWith('late')
    vi.advanceTimersByTime(8)
    expect(onData).toHaveBeenCalledOnce()
  })

  it('keeps only the most recent output in the history buffer', () => {
    const { session, ptys } = setup({ scrollbackBytes: 10 })
    session.open()
    ptys[0]!.emitData('0123456789abcde')
    ptys[0]!.emitData('fghij')
    expect(session.open().snapshot).toBe('abcdefghij')
  })

  it('starts a trimmed history at a line boundary so the replay never begins mid-sequence', () => {
    const { session, ptys } = setup({ scrollbackBytes: 12 })
    session.open()
    ptys[0]!.emitData('\x1b[93mold line\r\n')
    ptys[0]!.emitData('new\r\nPS> ')
    expect(session.open().snapshot).toBe('new\r\nPS> ')
  })

  it('keeps the history bounded under a flood of small chunks', () => {
    const { session, ptys } = setup({ scrollbackBytes: 100 })
    session.open()
    for (let i = 0; i < 10_000; i++) ptys[0]!.emitData(`line ${i}\r\n`)
    const { snapshot } = session.open()
    expect(snapshot.length).toBeLessThanOrEqual(100)
    expect(snapshot.endsWith('line 9999\r\n')).toBe(true)
    expect(snapshot.startsWith('line ')).toBe(true)
  })

  it('reports the end of the shell after flushing its last output, and starts a new one on the next open', () => {
    const { session, spawn, ptys, onData, onExit } = setup()
    session.open()
    ptys[0]!.emitData('bye')
    ptys[0]!.emitExit(3)
    expect(onData).toHaveBeenCalledWith('bye')
    expect(onExit).toHaveBeenCalledWith(3)
    expect(onData.mock.invocationCallOrder[0]).toBeLessThan(onExit.mock.invocationCallOrder[0]!)

    session.write('ignored\r')
    expect(ptys[0]!.written).toEqual([])

    expect(session.open()).toEqual({ state: 'running', snapshot: '', shell: SHELL })
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('reports a shell that cannot start as unavailable', () => {
    const { session, logger } = setup({ spawnError: new Error('File not found') })
    expect(() => session.open()).toThrow(expect.objectContaining({ code: 'UNAVAILABLE' }))
    expect(logger.entries.some((e) => e.level === 'error')).toBe(true)
  })

  it('never kills the pty (node-pty forks a helper on Windows)', () => {
    const { session, ptys } = setup()
    session.open()
    ptys[0]!.emitExit(0)
    session.open()
    expect(ptys.every((p) => p.kill.mock.calls.length === 0)).toBe(true)
  })

  it('never logs what is typed or printed', () => {
    const { session, ptys, logger } = setup()
    session.open()
    session.write('secret-input\r')
    ptys[0]!.emitData('secret-output')
    vi.advanceTimersByTime(8)
    ptys[0]!.emitExit(1)
    const logged = JSON.stringify(logger.entries)
    expect(logged).not.toContain('secret-input')
    expect(logged).not.toContain('secret-output')
  })
})
