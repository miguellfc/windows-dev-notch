import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { NotchApi } from '../../src/shared/ipc/api'

type NotchWindow = { notch: NotchApi; require?: unknown; process?: unknown }
interface WindowInfo {
  title: string
  height: number
  y: number
  visible: boolean
  alwaysOnTop: boolean
}

let userData: string

const launch = async (): Promise<{ app: ElectronApplication; notch: Page }> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RENDERER_URL') env[key] = value
  }
  env['NOTCH_USER_DATA_DIR'] = userData
  // Keep the capsule independent of whatever window happens to be in front during the run.
  env['NOTCH_DISABLE_FOREGROUND_WATCH'] = '1'
  // Never touch the real ~/.claude/settings.json nor collide with an installed notch on 47600.
  env['NOTCH_CLAUDE_SETTINGS'] = join(userData, 'claude-settings.json')
  env['NOTCH_CLAUDE_PORT'] = '0'
  const app = await electron.launch({ args: ['.'], env })
  const notch = await app.firstWindow()
  await notch.emulateMedia({ reducedMotion: 'reduce' })
  await expect(notch.getByTestId('notch-capsule')).toBeVisible()
  return { app, notch }
}

const capsuleWindow = async (app: ElectronApplication): Promise<WindowInfo> => {
  const all = (await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({
      title: w.getTitle(),
      height: w.getBounds().height,
      y: w.getBounds().y,
      visible: w.isVisible(),
      alwaysOnTop: w.isAlwaysOnTop(),
    })),
  )) as WindowInfo[]
  const found = all.find((w) => w.title === 'Developer Notch')
  if (!found) throw new Error('Capsule window not found')
  return found
}

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'notch-e2e-'))
})

test.afterEach(() => {
  // Windows can keep a profile file locked for a moment after Electron exits.
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('renderer is isolated from Node and locked down by CSP', async () => {
  const { app, notch } = await launch()

  const exposure = await notch.evaluate(() => {
    const win = globalThis as unknown as NotchWindow
    return { require: typeof win.require, process: typeof win.process, keys: Object.keys(win.notch).sort() }
  })
  expect(exposure).toEqual({ require: 'undefined', process: 'undefined', keys: ['app', 'claude', 'events', 'notch', 'settings', 'terminal'] })

  const csp = await notch.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
  expect(csp).toContain("default-src 'none'")
  expect(csp).toMatch(/script-src 'self';/)
  expect(csp).not.toContain('unsafe-eval')
  // Only styles are relaxed (xterm.js injects <style> at runtime).
  expect(csp?.match(/'unsafe-inline'/g)).toHaveLength(1)
  expect(csp).toContain("style-src 'self' 'unsafe-inline'")

  const invalid = await notch.evaluate(() =>
    (globalThis as unknown as NotchWindow).notch.notch.request({ intent: 'explode' as 'expand' }),
  )
  expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })

  await app.close()
})

test('capsule floats at the top, grows to the panel and shrinks back', async () => {
  const { app, notch } = await launch()

  const compact = await capsuleWindow(app)
  expect(compact).toMatchObject({ visible: true, alwaysOnTop: true, y: 0 })
  await expect(notch.getByTestId('notch-capsule')).toHaveAttribute('data-mode', 'compact')

  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.notch.request({ intent: 'expand' }))
  await expect(notch.getByTestId('notch-capsule')).toHaveAttribute('data-mode', 'expanded')
  await expect.poll(async () => (await capsuleWindow(app)).height).toBeGreaterThan(compact.height)

  await notch.keyboard.press('Escape')
  await expect(notch.getByTestId('notch-capsule')).toHaveAttribute('data-mode', 'compact')
  await expect.poll(async () => (await capsuleWindow(app)).height).toBe(compact.height)

  await app.close()
})

test('hide from the panel removes the capsule without quitting', async () => {
  const { app, notch } = await launch()

  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.notch.request({ intent: 'expand' }))
  await notch.getByRole('button', { name: /hide|ocultar/i }).click()
  await expect.poll(async () => (await capsuleWindow(app)).visible).toBe(false)

  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.notch.request({ intent: 'toggle' }))
  await expect.poll(async () => (await capsuleWindow(app)).visible).toBe(true)

  await app.close()
})

test('Control Center changes language live and persists it with the shortcut', async () => {
  let { app, notch } = await launch()

  const opened = app.waitForEvent('window')
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.app.openControlCenter())
  const controlCenter = await opened
  await expect(controlCenter.getByRole('heading', { level: 1 })).toBeVisible()

  await controlCenter.getByRole('radio', { name: 'Español' }).click()
  await expect(controlCenter.getByRole('button', { name: 'Atajo' })).toBeVisible()
  await expect.poll(() => notch.evaluate(() => (globalThis as unknown as { document: { documentElement: { lang: string } } }).document.documentElement.lang)).toBe('es')

  const saved = await controlCenter.evaluate(() =>
    (globalThis as unknown as NotchWindow).notch.settings.update({ shortcut: 'Alt+Shift+F9' }),
  )
  expect(saved).toMatchObject({ ok: true, data: { shortcut: 'Alt+Shift+F9' } })
  await app.close()

  const settings = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as Record<string, unknown>
  expect(settings).toMatchObject({ language: 'es', shortcut: 'Alt+Shift+F9' })

  ;({ app, notch } = await launch())
  const runtime = await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.app.getRuntime())
  expect(runtime).toMatchObject({ ok: true, data: { shortcutRegistered: true } })
  await expect.poll(() => notch.evaluate(() => (globalThis as unknown as { document: { documentElement: { lang: string } } }).document.documentElement.lang)).toBe('es')
  await app.close()
})
