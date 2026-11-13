import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSecureTokenStore } from '../../../src/main/services/secure-token-store'
import { createMemoryLogger } from '../helpers/memory-logger'

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
  decryptString: (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8'),
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'secure-token-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('secure token store', () => {
  it('keeps one token per file, encrypted, and logs under its own scope without the token', async () => {
    const logger = createMemoryLogger()
    const github = createSecureTokenStore({ file: join(dir, 'code-review-github.bin'), safeStorage: fakeSafeStorage, logger, logScope: 'code-review-token' })
    const gitlab = createSecureTokenStore({ file: join(dir, 'code-review-gitlab.bin'), safeStorage: fakeSafeStorage, logger, logScope: 'code-review-token' })
    await github.save('ghp_SECRET1')
    await gitlab.save('glpat-SECRET2')
    await github.clear()

    const reloadedGithub = createSecureTokenStore({ file: join(dir, 'code-review-github.bin'), safeStorage: fakeSafeStorage, logger, logScope: 'x' })
    const reloadedGitlab = createSecureTokenStore({ file: join(dir, 'code-review-gitlab.bin'), safeStorage: fakeSafeStorage, logger, logScope: 'x' })
    expect(await reloadedGithub.load()).toBeNull()
    expect(await reloadedGitlab.load()).toBe('glpat-SECRET2')
    expect(await readFile(join(dir, 'code-review-gitlab.bin'), 'utf8')).not.toContain('SECRET2')
    expect(logger.entries.some((e) => e.scope === 'test:code-review-token')).toBe(true)
    expect(JSON.stringify(logger.entries)).not.toMatch(/SECRET/)
  })
})
