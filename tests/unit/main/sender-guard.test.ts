import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createSenderGuard } from '../../../src/main/ipc/sender-guard'

const rendererDir = join(process.cwd(), 'out', 'renderer')
const fileUrl = (...parts: string[]) => pathToFileURL(join(rendererDir, ...parts)).href

describe('createSenderGuard (production)', () => {
  const isTrusted = createSenderGuard({ rendererDir })

  it('trusts pages inside the bundled renderer folder', () => {
    expect(isTrusted(fileUrl('notch', 'index.html'))).toBe(true)
    expect(isTrusted(fileUrl('control-center', 'index.html'))).toBe(true)
  })

  it('rejects files outside the renderer folder', () => {
    expect(isTrusted(pathToFileURL(join(process.cwd(), 'evil.html')).href)).toBe(false)
    expect(isTrusted(pathToFileURL(join(rendererDir, '..', 'renderer-evil', 'x.html')).href)).toBe(false)
  })

  it('rejects remote and malformed URLs', () => {
    expect(isTrusted('https://example.com/notch/index.html')).toBe(false)
    expect(isTrusted('http://localhost:5173/notch/index.html')).toBe(false)
    expect(isTrusted('not a url')).toBe(false)
    expect(isTrusted('')).toBe(false)
  })

  it('compares paths case-insensitively when asked (Windows)', () => {
    const guard = createSenderGuard({ rendererDir, caseInsensitive: true })
    expect(guard(fileUrl('notch', 'index.html').toUpperCase().replace('FILE:', 'file:'))).toBe(true)
  })
})

describe('createSenderGuard (development)', () => {
  const isTrusted = createSenderGuard({ rendererDir, devServerUrl: 'http://localhost:5173' })

  it('trusts the dev server origin', () => {
    expect(isTrusted('http://localhost:5173/notch/index.html')).toBe(true)
  })

  it('rejects other ports, hosts and protocols', () => {
    expect(isTrusted('http://localhost:5174/notch/index.html')).toBe(false)
    expect(isTrusted('http://127.0.0.1:5173/notch/index.html')).toBe(false)
    expect(isTrusted('https://localhost:5173/notch/index.html')).toBe(false)
  })

  it('ignores a malformed dev server URL instead of trusting everything', () => {
    const guard = createSenderGuard({ rendererDir, devServerUrl: '::bad::' })
    expect(guard('http://localhost:5173/')).toBe(false)
    expect(guard(fileUrl('notch', 'index.html'))).toBe(true)
  })
})
