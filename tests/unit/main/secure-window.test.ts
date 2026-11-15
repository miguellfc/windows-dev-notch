import { EventEmitter } from 'node:events'
import type { Session, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { denyAllPermissions, hardenWebContents, secureWebPreferences } from '../../../src/main/windows/secure-window'
import { createMemoryLogger } from '../helpers/memory-logger'

describe('secureWebPreferences', () => {
  it('locks down the renderer', () => {
    const prefs = secureWebPreferences({ preload: 'C:\\app\\preload.js', devTools: false })
    expect(prefs).toMatchObject({
      preload: 'C:\\app\\preload.js',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: false,
    })
  })
})

class FakeWebContents extends EventEmitter {
  openHandler: ((details: { url: string }) => { action: string }) | undefined
  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }) {
    this.openHandler = handler
  }
}

describe('hardenWebContents', () => {
  const setup = () => {
    const contents = new FakeWebContents()
    const logger = createMemoryLogger()
    hardenWebContents(contents as unknown as WebContents, logger)
    return { contents, logger }
  }

  it.each(['will-navigate', 'will-redirect', 'will-frame-navigate'])('blocks %s', (eventName) => {
    const { contents, logger } = setup()
    const event = { preventDefault: vi.fn(), url: 'https://evil.test/a?token=secret#x', isMainFrame: false }
    contents.emit(eventName, event, 'https://evil.test/a?token=secret#x')
    expect(event.preventDefault).toHaveBeenCalled()
    expect(logger.entries[0]).toMatchObject({ level: 'warn', meta: { url: 'https://evil.test/a' } })
  })

  it('lets the main frame reload (will-frame-navigate with isMainFrame)', () => {
    const { contents, logger } = setup()
    const event = { preventDefault: vi.fn(), url: 'http://localhost:5173/notch/index.html', isMainFrame: true }
    contents.emit('will-frame-navigate', event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(logger.entries).toEqual([])
  })

  it('blocks webview attachment', () => {
    const { contents } = setup()
    const event = { preventDefault: vi.fn() }
    contents.emit('will-attach-webview', event)
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('denies window.open', () => {
    const { contents } = setup()
    expect(contents.openHandler?.({ url: 'https://evil.test' })).toEqual({ action: 'deny' })
  })
})

describe('denyAllPermissions', () => {
  it('denies permission requests, checks and device access', () => {
    let request: ((wc: unknown, permission: string, callback: (granted: boolean) => void) => void) | undefined
    let check: (() => boolean) | undefined
    let device: (() => boolean) | undefined
    const fakeSession = {
      setPermissionRequestHandler: (handler: typeof request) => (request = handler),
      setPermissionCheckHandler: (handler: typeof check) => (check = handler),
      setDevicePermissionHandler: (handler: typeof device) => (device = handler),
    }

    denyAllPermissions(fakeSession as unknown as Session)

    const callback = vi.fn()
    request?.({}, 'media', callback)
    expect(callback).toHaveBeenCalledWith(false)
    expect(check?.()).toBe(false)
    expect(device?.()).toBe(false)
  })
})
