import type { Logger } from '../services/logger'
import { createSecureTokenStore, type TokenSafeStorage, type TokenStore } from '../services/secure-token-store'

export type { TokenSafeStorage, TokenStore } from '../services/secure-token-store'

export interface TokenStoreOptions {
  file: string
  safeStorage: TokenSafeStorage
  logger: Logger
}

/** The Gmail refresh token: the shared encrypted store with Gmail's log scope. */
export const createTokenStore = (options: TokenStoreOptions): TokenStore => createSecureTokenStore({ ...options, logScope: 'gmail-token' })
