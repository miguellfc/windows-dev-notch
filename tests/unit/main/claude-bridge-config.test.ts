import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DYNAMIC_PORT_MAX,
  DYNAMIC_PORT_MIN,
  loadBridgeConfig,
  randomDynamicPort,
  rotatePort,
  rotateToken,
} from '../../../src/main/claude/bridge-config'

// Fake "safeStorage": reversible, but the output never contains the plain text.
const encrypt = (plain: string): Buffer => Buffer.from(Buffer.from(plain, 'utf8').map((b) => b ^ 0x5a))
const decrypt = (buf: Buffer): string => Buffer.from(buf.map((b) => b ^ 0x5a)).toString('utf8')

describe('bridge config', () => {
  let dir: string
  let file: string
  let counter: number
  let ports: number[]
  const randomToken = () => `token-${(counter += 1)}`
  // Injected RNG: each call takes the next port from the list.
  const randomPort = () => ports.shift() ?? 60_000
  const deps = () => ({ file, encrypt, decrypt, randomToken, randomPort })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'notch-bridge-config-'))
    file = join(dir, 'claude-bridge.json')
    counter = 0
    ports = [51_234, 62_001, 62_001, 55_555]
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('creates the file with a random dynamic port (not a fixed one) and an encrypted token', async () => {
    const config = await loadBridgeConfig(deps())
    expect(config).toEqual({ port: 51_234, token: 'token-1' })
    const text = await readFile(file, 'utf8')
    expect(text).not.toContain('token-1')
    const stored = JSON.parse(text) as { version: number; port: number; token: string }
    expect(stored.version).toBe(1)
    expect(stored.port).toBe(51_234)
    expect(decrypt(Buffer.from(stored.token, 'base64'))).toBe('token-1')
  })

  it('returns the same token and port across loads', async () => {
    const first = await loadBridgeConfig(deps())
    const second = await loadBridgeConfig(deps())
    expect(second).toEqual(first)
    expect(counter).toBe(1)
  })

  it('keeps a custom port stored in the file', async () => {
    await loadBridgeConfig(deps())
    const stored = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    await writeFile(file, JSON.stringify({ ...stored, port: 48123 }))
    expect((await loadBridgeConfig(deps())).port).toBe(48123)
  })

  it('regenerates the token when the file is corrupt', async () => {
    await writeFile(file, '{not json')
    const config = await loadBridgeConfig(deps())
    expect(config.token).toBe('token-1')
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1, port: 51_234 })
  })

  it('regenerates the token when it cannot be decrypted', async () => {
    await loadBridgeConfig(deps())
    const failing = {
      ...deps(),
      decrypt: () => {
        throw new Error('cannot decrypt')
      },
    }
    const config = await loadBridgeConfig(failing)
    expect(config.token).toBe('token-2')
    expect(await loadBridgeConfig(deps())).toEqual({ port: 62_001, token: 'token-2' })
  })

  it('rotateToken changes and persists the token, keeping the port', async () => {
    const before = await loadBridgeConfig(deps())
    const rotated = await rotateToken(deps())
    expect(rotated.token).not.toBe(before.token)
    expect(rotated.port).toBe(before.port)
    expect(await loadBridgeConfig(deps())).toEqual(rotated)
  })

  it('rotatePort picks a different random port, keeps the token and persists it', async () => {
    const before = await loadBridgeConfig(deps())
    // The RNG first returns the current port again: it must be skipped.
    ports = [before.port, 62_001]
    const rotated = await rotatePort(deps())
    expect(rotated).toEqual({ port: 62_001, token: before.token })
    expect(await loadBridgeConfig(deps())).toEqual(rotated)
  })

  it('randomDynamicPort stays inside 49152-65535', () => {
    expect(DYNAMIC_PORT_MIN).toBe(49_152)
    expect(DYNAMIC_PORT_MAX).toBe(65_535)
    for (let i = 0; i < 2_000; i += 1) {
      const port = randomDynamicPort()
      expect(Number.isInteger(port)).toBe(true)
      expect(port).toBeGreaterThanOrEqual(49_152)
      expect(port).toBeLessThanOrEqual(65_535)
    }
  })
})
