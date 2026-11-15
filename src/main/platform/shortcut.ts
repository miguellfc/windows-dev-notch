import type { Logger } from '../services/logger'

/** The part of Electron's globalShortcut we use. */
export interface ShortcutRegistrar {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

export type ShortcutResult = { ok: true } | { ok: false; reason: 'unavailable' | 'invalid' }

export interface ShortcutService {
  /** Registers `accelerator`, releasing the previous one only if the new one succeeds. */
  apply(accelerator: string): ShortcutResult
  current(): string | null
  dispose(): void
}

export function createShortcutService(options: {
  registrar: ShortcutRegistrar
  onTrigger: () => void
  logger: Logger
}): ShortcutService {
  const { registrar, onTrigger } = options
  const log = options.logger.child('shortcut')
  let current: string | null = null

  return {
    apply(accelerator) {
      if (accelerator === current) return { ok: true }
      let registered: boolean
      try {
        registered = registrar.register(accelerator, onTrigger)
      } catch (error) {
        log.warn('Shortcut rejected by Electron', { accelerator, error })
        return { ok: false, reason: 'invalid' }
      }
      if (!registered) {
        log.warn('Shortcut is taken by another application', { accelerator })
        return { ok: false, reason: 'unavailable' }
      }
      if (current) registrar.unregister(current)
      current = accelerator
      log.info('Shortcut registered', { accelerator })
      return { ok: true }
    },
    current: () => current,
    dispose() {
      if (current) registrar.unregister(current)
      current = null
    },
  }
}
