import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { NotchApi } from '../../src/shared/ipc/api'

type NotchWindow = { notch: NotchApi; require?: unknown; process?: unknown }

let userData: string

const launch = async (): Promise<{ app: ElectronApplication; page: Page }> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RENDERER_URL') env[key] = value
  }
  env['NOTCH_USER_DATA_DIR'] = userData
  const app = await electron.launch({ args: ['.'], env })
  const page = await app.firstWindow()
  // Screenshots must show settled states, not colour transitions in flight.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByTestId('notch-capsule')).toBeVisible()
  return { app, page }
}

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'notch-e2e-'))
})

test.afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

test('renderer is isolated from Node and locked down by CSP', async () => {
  const { app, page } = await launch()

  const exposure = await page.evaluate(() => {
    const win = globalThis as unknown as NotchWindow
    return {
      require: typeof win.require,
      process: typeof win.process,
      notchKeys: Object.keys(win.notch).sort(),
    }
  })
  expect(exposure).toEqual({ require: 'undefined', process: 'undefined', notchKeys: ['app', 'settings'] })

  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
  expect(csp).toContain("default-src 'none'")
  expect(csp).not.toContain('unsafe')

  await app.close()
})

test('main process rejects invalid IPC input', async () => {
  const { app, page } = await launch()

  const result = await page.evaluate(() =>
    (globalThis as unknown as NotchWindow).notch.settings.update({ language: 'fr' as 'en' }),
  )
  expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })

  await app.close()
})

test('language change travels renderer → main → disk and survives a restart', async () => {
  let { app, page } = await launch()

  await page.getByRole('button', { name: 'en', exact: true }).click()
  await expect(page.getByTestId('notch-language')).toHaveText('en')
  await expect(page.getByRole('button', { name: 'en', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.screenshot({ path: 'test-results/skeleton-notch-en.png' })
  await app.close()

  const saved = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as { language: string }
  expect(saved.language).toBe('en')

  ;({ app, page } = await launch())
  await expect(page.getByTestId('notch-language')).toHaveText('en')

  await page.getByRole('button', { name: 'es', exact: true }).click()
  await expect(page.getByTestId('notch-language')).toHaveText('es')
  await page.screenshot({ path: 'test-results/skeleton-notch-es.png' })
  await app.close()
})
