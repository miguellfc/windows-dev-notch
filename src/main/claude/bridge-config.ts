import { randomInt } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * New bridges listen on a random port of the dynamic range instead of a fixed one, so
 * another local account cannot predict it and squat it before us (Claude's settings.json,
 * which holds the port, lives in the user profile and is not readable by other accounts).
 */
export const DYNAMIC_PORT_MIN = 49_152
export const DYNAMIC_PORT_MAX = 65_535

export const randomDynamicPort = (): number => randomInt(DYNAMIC_PORT_MIN, DYNAMIC_PORT_MAX + 1)

export type BridgeConfigDeps = {
  file: string
  encrypt: (plain: string) => Buffer
  decrypt: (buf: Buffer) => string
  /** Hex of 32 random bytes. */
  randomToken: () => string
  /** A port in DYNAMIC_PORT_MIN..DYNAMIC_PORT_MAX (`randomDynamicPort` in production). */
  randomPort: () => number
}

export type BridgeConfig = { port: number; token: string }

const isPort = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65_535

const readStored = async (deps: BridgeConfigDeps): Promise<BridgeConfig | null> => {
  try {
    const raw: unknown = JSON.parse(await readFile(deps.file, 'utf8'))
    if (typeof raw !== 'object' || raw === null) return null
    const { version, port, token } = raw as Record<string, unknown>
    if (version !== 1 || !isPort(port) || typeof token !== 'string' || token === '') return null
    const plain = deps.decrypt(Buffer.from(token, 'base64'))
    return plain === '' ? null : { port, token: plain }
  } catch {
    // Missing, corrupt or undecryptable (e.g. another Windows user/machine): start over.
    return null
  }
}

const write = async (deps: BridgeConfigDeps, config: BridgeConfig): Promise<void> => {
  const temp = `${deps.file}.tmp`
  const body = { version: 1, port: config.port, token: deps.encrypt(config.token).toString('base64') }
  await mkdir(dirname(deps.file), { recursive: true })
  try {
    await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
    await rename(temp, deps.file)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** Reads `claude-bridge.json`; creates it (new token) when missing, corrupt or not decryptable. */
export const loadBridgeConfig = async (deps: BridgeConfigDeps): Promise<BridgeConfig> => {
  const existing = await readStored(deps)
  if (existing) return existing
  const created = { port: deps.randomPort(), token: deps.randomToken() }
  await write(deps, created)
  return created
}

/** Replaces the token, keeping the stored port. */
export const rotateToken = async (deps: BridgeConfigDeps): Promise<BridgeConfig> => {
  const existing = await readStored(deps)
  const next = { port: existing?.port ?? deps.randomPort(), token: deps.randomToken() }
  await write(deps, next)
  return next
}

/** Moves the bridge to another random port (e.g. ours was taken), keeping the token. */
export const rotatePort = async (deps: BridgeConfigDeps): Promise<BridgeConfig> => {
  const existing = await readStored(deps)
  let port = deps.randomPort()
  // A handful of draws is plenty: the range has 16 384 ports.
  for (let attempt = 0; attempt < 8 && port === existing?.port; attempt += 1) port = deps.randomPort()
  const next = { port, token: existing?.token ?? deps.randomToken() }
  await write(deps, next)
  return next
}
