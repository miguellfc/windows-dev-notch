import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTokenStore } from '../../../src/main/gmail/token-store'
import { readTextFile, writeFileAtomic } from '../../../src/main/services/fs-atomic'
import { createMemoryLogger } from '../helpers/memory-logger'

vi.mock('../../../src/main/services/fs-atomic', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/main/services/fs-atomic')>()
  return { ...original, readTextFile: vi.fn(original.readTextFile), writeFileAtomic: vi.fn(original.writeFileAtomic) }
})

const TOKEN = 'refresh-token-1//SECRET-VALUE'

/** Reversible fake: XOR with 0x5a, so the ciphertext never contains the plain text. */
const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s: string) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
  decryptString: (b: Buffer) => {
    const text = Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8')
    if (!text.startsWith('refresh-')) throw new Error('bad ciphertext')
    return text
  },
})

let dir: string
let file: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gmail-token-'))
  file = join(dir, 'gmail-token.bin')
  vi.mocked(writeFileAtomic).mockClear()
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const exists = (path: string) => stat(path).then(() => true, () => false)
const make = (available = true) => {
  const logger = createMemoryLogger()
  return { logger, store: createTokenStore({ file, safeStorage: fakeSafeStorage(available), logger }) }
}

describe('token store', () => {
  it('returns null when nothing was saved', async () => {
    expect(await make().store.load()).toBeNull()
  })

  it('saves encrypted (never plain text) and loads it back from a new store', async () => {
    const a = make()
    await a.store.save(TOKEN)
    expect(a.store.persistent).toBe(true)
    const raw = await readFile(file)
    expect(raw.toString('utf8')).not.toContain(TOKEN)
    expect(raw.toString('latin1')).not.toContain('SECRET-VALUE')
    expect(await make().store.load()).toBe(TOKEN)
  })

  it('writes through fs-atomic', async () => {
    await make().store.save(TOKEN)
    expect(writeFileAtomic).toHaveBeenCalledTimes(1)
    expect(vi.mocked(writeFileAtomic).mock.calls[0]![0]).toBe(file)
  })

  it('keeps the token only in memory without encryption', async () => {
    const { store, logger } = make(false)
    expect(store.persistent).toBe(false)
    await store.save(TOKEN)
    expect(await exists(file)).toBe(false)
    expect(writeFileAtomic).not.toHaveBeenCalled()
    expect(await store.load()).toBe(TOKEN)
    expect(JSON.stringify(logger.entries)).not.toContain(TOKEN)
    expect(await make(false).store.load()).toBeNull()
  })

  it('ignores a leftover file without encryption', async () => {
    await make().store.save(TOKEN)
    expect(await make(false).store.load()).toBeNull()
  })

  it('returns null and deletes a file that cannot be decrypted', async () => {
    await writeFile(file, 'not-a-valid-ciphertext')
    const { store, logger } = make()
    expect(await store.load()).toBeNull()
    expect(await exists(file)).toBe(false)
    expect(logger.entries.some((e) => e.level === 'warn')).toBe(true)
  })

  it('clear removes the file and the in-memory token', async () => {
    const { store } = make()
    await store.save(TOKEN)
    await store.clear()
    expect(await exists(file)).toBe(false)
    expect(await store.load()).toBeNull()
    await expect(store.clear()).resolves.toBeUndefined()
  })

  it('never logs the token', async () => {
    const { store, logger } = make()
    await store.save(TOKEN)
    await store.load()
    await writeFile(file, 'garbage')
    await make().store.load()
    await store.clear()
    expect(JSON.stringify(logger.entries)).not.toContain(TOKEN)
  })

  it('keeps a valid file when reading it fails with a transient I/O error', async () => {
    await make().store.save(TOKEN)
    vi.mocked(readTextFile).mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }))
    const { store, logger } = make()
    expect(await store.load()).toBeNull()
    expect(await exists(file)).toBe(true)
    expect(JSON.stringify(logger.entries)).toContain('EBUSY')
    expect(await make().store.load()).toBe(TOKEN)
  })

  it('deletes a stale encrypted file when saving without encryption', async () => {
    await make().store.save(TOKEN)
    expect(await exists(file)).toBe(true)
    const { store } = make(false)
    await store.save('refresh-token-2')
    expect(await exists(file)).toBe(false)
    expect(await make().store.load()).toBeNull()
  })
})
