import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(message: string, meta?: unknown): void
  info(message: string, meta?: unknown): void
  warn(message: string, meta?: unknown): void
  error(message: string, meta?: unknown): void
  child(scope: string): Logger
}

export interface FileLoggerOptions {
  dir: string
  /** Base name without extension; files are `<name>.log`, `<name>.1.log`, … */
  fileName?: string
  maxBytes?: number
  maxFiles?: number
  minLevel?: LogLevel
  mirrorToConsole?: boolean
  now?: () => Date
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** Reduces a URL to origin + path (no query, hash or credentials) before it reaches a log file. */
export function urlForLog(value: string | null | undefined, maxLength = 200): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    const base = url.protocol === 'file:' ? `file://${url.pathname}` : `${url.origin}${url.pathname}`
    return base.slice(0, maxLength)
  } catch {
    return '[invalid url]'
  }
}

function serializeMeta(meta: unknown): string {
  if (meta === undefined) return ''
  try {
    return ` ${JSON.stringify(meta, (_key, value: unknown) =>
      value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value,
    )}`
  } catch {
    return ' [unserializable]'
  }
}

/**
 * Append-only file logger with size-based rotation. Logging must never crash the app,
 * so every filesystem failure is swallowed.
 */
export function createFileLogger(options: FileLoggerOptions): Logger {
  const {
    dir,
    fileName = 'main',
    maxBytes = 1_000_000,
    maxFiles = 3,
    minLevel = 'debug',
    mirrorToConsole = false,
    now = () => new Date(),
  } = options
  const fileAt = (index: number) => join(dir, index === 0 ? `${fileName}.log` : `${fileName}.${index}.log`)
  let currentSize: number | undefined

  const ensureReady = (): number => {
    if (currentSize === undefined) {
      mkdirSync(dir, { recursive: true })
      currentSize = existsSync(fileAt(0)) ? statSync(fileAt(0)).size : 0
    }
    return currentSize
  }

  const rotate = () => {
    rmSync(fileAt(maxFiles - 1), { force: true })
    for (let index = maxFiles - 2; index >= 0; index -= 1) {
      if (existsSync(fileAt(index))) renameSync(fileAt(index), fileAt(index + 1))
    }
    currentSize = 0
  }

  const write = (level: LogLevel, scope: string, message: string, meta: unknown) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return
    const line = `${now().toISOString()} ${level.toUpperCase()} [${scope}] ${message}${serializeMeta(meta)}\n`
    if (mirrorToConsole) console[level === 'debug' ? 'log' : level](line.trimEnd())
    try {
      const size = ensureReady()
      const bytes = Buffer.byteLength(line)
      if (size > 0 && size + bytes > maxBytes) rotate()
      appendFileSync(fileAt(0), line)
      currentSize = (currentSize ?? 0) + bytes
    } catch {
      // Logging is best-effort; a broken log folder must not take the app down.
    }
  }

  const make = (scope: string): Logger => ({
    debug: (message, meta) => write('debug', scope, message, meta),
    info: (message, meta) => write('info', scope, message, meta),
    warn: (message, meta) => write('warn', scope, message, meta),
    error: (message, meta) => write('error', scope, message, meta),
    child: (childScope) => make(`${scope}:${childScope}`),
  })

  return make(fileName)
}
