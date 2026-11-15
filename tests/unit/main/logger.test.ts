import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFileLogger } from '../../../src/main/services/logger'

let dir: string
const fixedNow = () => new Date('2026-11-09T10:00:00.000Z')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'notch-logs-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const read = (name = 'main.log') => readFileSync(join(dir, name), 'utf8')

describe('createFileLogger', () => {
  it('writes timestamped, scoped lines with metadata', () => {
    const logger = createFileLogger({ dir, now: fixedNow })
    logger.child('ipc').warn('Rejected sender', { url: 'https://evil.test' })

    expect(read()).toBe('2026-11-09T10:00:00.000Z WARN [main:ipc] Rejected sender {"url":"https://evil.test"}\n')
  })

  it('serializes errors with name and message', () => {
    const logger = createFileLogger({ dir, now: fixedNow })
    logger.error('Boom', { error: new TypeError('bad') })
    expect(read()).toContain('"error":{"name":"TypeError","message":"bad"')
  })

  it('drops entries below the minimum level', () => {
    const logger = createFileLogger({ dir, now: fixedNow, minLevel: 'info' })
    logger.debug('hidden')
    logger.info('shown')
    expect(read()).not.toContain('hidden')
    expect(read()).toContain('shown')
  })

  it('rotates files when the size limit is reached and keeps a bounded history', () => {
    const logger = createFileLogger({ dir, now: fixedNow, maxBytes: 200, maxFiles: 3 })
    for (let i = 0; i < 40; i += 1) {
      logger.info(`entry ${i.toString().padStart(2, '0')} ${'x'.repeat(40)}`)
    }

    expect(existsSync(join(dir, 'main.log'))).toBe(true)
    expect(existsSync(join(dir, 'main.1.log'))).toBe(true)
    expect(existsSync(join(dir, 'main.2.log'))).toBe(true)
    expect(existsSync(join(dir, 'main.3.log'))).toBe(false)
    expect(read()).toContain('entry 39')
    expect(Buffer.byteLength(read())).toBeLessThanOrEqual(200)
  })

  it('never throws when metadata cannot be serialized', () => {
    const logger = createFileLogger({ dir, now: fixedNow })
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(() => logger.info('circular', circular)).not.toThrow()
    expect(read()).toContain('[unserializable]')
  })

  it('never throws when the log folder is unusable', () => {
    const blocked = join(dir, 'file-not-folder')
    createFileLogger({ dir, fileName: 'file-not-folder' }).info('make a file')
    const logger = createFileLogger({ dir: blocked, now: fixedNow })
    expect(() => logger.error('still fine')).not.toThrow()
  })
})
