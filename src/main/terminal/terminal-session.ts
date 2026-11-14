import { ExposedIpcError } from '../ipc/errors'
import type { Logger } from '../services/logger'

/** The parts of a node-pty process the session uses; lets tests use a fake. */
export interface PtyLike {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  onData(cb: (data: string) => void): { dispose(): void }
  onExit(cb: (e: { exitCode: number }) => void): { dispose(): void }
}

export interface SpawnOptions {
  name: string
  cols: number
  rows: number
  cwd: string
  env: Record<string, string>
}

export type SpawnPty = (file: string, args: string[], options: SpawnOptions) => PtyLike

export interface TerminalSnapshot {
  state: 'running' | 'exited'
  exitCode?: number
  /** Recent output, replayed when the view opens again. */
  snapshot: string
  shell: string
}

export interface TerminalSession {
  /** Returns the live session, starting a new shell when there is none. */
  open(): TerminalSnapshot
  write(data: string): void
  resize(cols: number, rows: number): void
}

export interface TerminalSessionOptions {
  spawn: SpawnPty
  shell: string
  cwd: string
  env: Record<string, string>
  onData: (chunk: string) => void
  onExit: (exitCode: number) => void
  logger: Logger
  flushMs?: number
  scrollbackBytes?: number
  /** Whether the terminal view is on screen; output is only streamed while it is. */
  isViewing?: () => boolean
}

/**
 * The single PowerShell session behind the notch terminal. The main process owns it:
 * the shell, arguments, folder and environment are fixed here, never chosen by a renderer.
 * It never calls `kill()` — on Windows node-pty forks a helper for that, which the packaged
 * app (runAsNode fuse off) would turn into a second app instance. The shell ends with
 * the app or when the user types `exit`.
 */
export function createTerminalSession(options: TerminalSessionOptions): TerminalSession {
  const { spawn, shell, onData, onExit, flushMs = 8, scrollbackBytes = 262_144, isViewing = () => true } = options
  const log = options.logger.child('terminal')
  let pty: PtyLike | null = null
  let history = ''
  let pending = ''
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = null
    if (pending === '') return
    const chunk = pending
    pending = ''
    onData(chunk)
  }

  /** The last `scrollbackBytes` of output; when cut, it starts at a new line, never mid-sequence. */
  const recentHistory = () => {
    if (history.length <= scrollbackBytes) return history
    const tail = history.slice(-scrollbackBytes)
    const lineStart = tail.indexOf('\n')
    return lineStart === -1 ? tail : tail.slice(lineStart + 1)
  }

  const start = (): PtyLike => {
    let next: PtyLike
    try {
      next = spawn(shell, ['-NoLogo'], { name: 'xterm-256color', cols: 100, rows: 20, cwd: options.cwd, env: options.env })
    } catch (error) {
      log.error('Shell could not start', { shell, error })
      throw new ExposedIpcError('UNAVAILABLE', 'Shell could not start')
    }
    history = ''
    next.onData((data) => {
      // Append cheaply and trim only once the buffer doubles, so a flood of output does not copy
      // the whole history on every chunk.
      history += data
      if (history.length > scrollbackBytes * 2) history = history.slice(-scrollbackBytes)
      // Nobody is looking: the history is enough, the next open() replays it.
      if (!isViewing()) return
      pending += data
      timer ??= setTimeout(flush, flushMs)
    })
    next.onExit(({ exitCode }) => {
      flush()
      if (pty === next) pty = null
      log.info('Shell exited', { exitCode })
      onExit(exitCode)
    })
    log.info('Shell started', { shell, pid: next.pid })
    return next
  }

  return {
    open() {
      pty ??= start()
      // Output reaches the view either as an event sent before this reply, or in the snapshot.
      // The view ignores events until the reply arrives, so flushing first avoids duplicates.
      flush()
      return { state: 'running', snapshot: recentHistory(), shell }
    },
    write(data) {
      pty?.write(data)
    },
    resize(cols, rows) {
      pty?.resize(cols, rows)
    },
  }
}
