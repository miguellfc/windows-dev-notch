import type { Logger, LogLevel } from '../../../src/main/services/logger'

export interface LogEntry {
  level: LogLevel
  scope: string
  message: string
  meta?: unknown
}

/** In-memory logger for tests: records every entry instead of writing to disk. */
export function createMemoryLogger(scope = 'test', entries: LogEntry[] = []): Logger & { entries: LogEntry[] } {
  const write = (level: LogLevel) => (message: string, meta?: unknown) => {
    entries.push(meta === undefined ? { level, scope, message } : { level, scope, message, meta })
  }
  return {
    entries,
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: (childScope: string) => createMemoryLogger(`${scope}:${childScope}`, entries),
  }
}
