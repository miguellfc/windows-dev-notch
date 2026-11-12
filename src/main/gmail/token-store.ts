import { rm } from 'node:fs/promises'
import { readTextFile, writeFileAtomic } from '../services/fs-atomic'
import type { Logger } from '../services/logger'

export interface TokenSafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface TokenStoreOptions {
  file: string
  safeStorage: TokenSafeStorage
  logger: Logger
}

export interface TokenStore {
  load(): Promise<string | null>
  save(token: string): Promise<void>
  clear(): Promise<void>
  /** True when the token survives a restart (OS encryption is available). */
  readonly persistent: boolean
}

/** Name and code of a thrown value, without its message (which could quote data). */
const errorSummary = (error: unknown): { name: string; code?: string } => {
  const name = error instanceof Error ? error.name : typeof error
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? { name, code } : { name }
}

/**
 * Holds the Gmail refresh token. On disk it is only ever the safeStorage ciphertext (base64);
 * without OS encryption it lives in memory for the session and nothing is written. Never logs it.
 */
export function createTokenStore({ file, safeStorage, logger }: TokenStoreOptions): TokenStore {
  const log = logger.child('gmail-token')
  let memory: string | null = null
  let queue: Promise<unknown> = Promise.resolve()

  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task)
    queue = run.catch(() => undefined)
    return run
  }

  const discardFile = async (): Promise<void> => {
    try {
      await rm(file, { force: true })
    } catch (error) {
      log.warn('Could not delete the token file', { error: errorSummary(error) })
    }
  }

  return {
    get persistent() {
      return safeStorage.isEncryptionAvailable()
    },

    load() {
      return serialize(async () => {
        if (memory !== null) return memory
        if (!safeStorage.isEncryptionAvailable()) return null
        let text: string | null
        try {
          text = await readTextFile(file)
        } catch (error) {
          // Transient I/O trouble (EBUSY, EPERM): the file may be fine, so keep it.
          log.warn('Could not read the token file', { error: errorSummary(error) })
          return null
        }
        if (text === null) return null
        try {
          const token = safeStorage.decryptString(Buffer.from(text.trim(), 'base64'))
          if (!token) throw new Error('empty token')
          memory = token
          return token
        } catch (error) {
          log.warn('Stored token could not be decrypted; discarding it', { error: errorSummary(error) })
          await discardFile()
          return null
        }
      })
    },

    save(token) {
      return serialize(async () => {
        memory = token
        if (!safeStorage.isEncryptionAvailable()) {
          log.warn('OS encryption unavailable; the session will not survive a restart')
          await discardFile() // a stale encrypted token must not load later
          return
        }
        await writeFileAtomic(file, safeStorage.encryptString(token).toString('base64'))
        log.debug('Token saved')
      })
    },

    clear() {
      return serialize(async () => {
        memory = null
        await discardFile()
      })
    },
  }
}
