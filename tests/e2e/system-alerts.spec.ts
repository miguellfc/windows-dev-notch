import { freemem, tmpdir, totalmem } from 'node:os'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { NotchApi } from '../../src/shared/ipc/api'
import { settle } from './settle'
import { showCompact } from './pointer'

type NotchWindow = { notch: NotchApi }

let userData: string
let launched: ElectronApplication | undefined

/** Version 3 settings: RAM alert at 50 % (always firing on a dev machine); the other alerts off. */
const writeSettings = (): void => {
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({
      version: 3,
      language: 'es',
      shortcut: 'Control+Alt+Space',
      launchAtLogin: false,
      reminders: { snoozeMinutes: 10, sound: false },
      systemAlerts: {
        cpu: { enabled: false, percent: 90, sustainSeconds: 30 },
        ram: { enabled: true, percent: 50 },
        battery: { enabled: false, percent: 15 },
        disk: { enabled: false, freePercent: 10 },
      },
    }),
    'utf8',
  )
}

const launch = async (): Promise<{ app: ElectronApplication; notch: Page }> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RENDERER_URL') env[key] = value
  }
  env['NOTCH_USER_DATA_DIR'] = userData
  env['NOTCH_DISABLE_FOREGROUND_WATCH'] = '1'
  // Never touch the real ~/.claude/settings.json nor collide with an installed notch on 47600.
  env['NOTCH_CLAUDE_SETTINGS'] = join(userData, 'claude-settings.json')
  env['NOTCH_CLAUDE_PORT'] = '0'
  const app = await electron.launch({ args: ['.'], env })
  launched = app
  const notch = await app.firstWindow()
  await notch.emulateMedia({ reducedMotion: 'reduce' })
  await expect(notch.getByTestId('notch-capsule')).toBeVisible()
  return { app, notch }
}

const setLanguage = (notch: Page, language: 'es' | 'en') =>
  notch.evaluate((value) => (globalThis as unknown as NotchWindow).notch.settings.update({ language: value }), language)

const openControlCenter = async (app: ElectronApplication, notch: Page): Promise<Page> => {
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.app.openControlCenter())
  const cc = await app.waitForEvent('window', (page) => page.url().includes('control-center'))
  await cc.waitForLoadState('domcontentloaded')
  await cc.emulateMedia({ reducedMotion: 'reduce' })
  return cc
}

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'notch-e2e-alerts-'))
  writeSettings()
})

test.afterEach(async () => {
  await launched?.close().catch(() => undefined)
  launched = undefined
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('the RAM metric alerts against a 50 % threshold and recovers when it is raised to 99 %', async () => {
  // 50 % is the lowest threshold the settings allow: with less RAM in use there is nothing to alert on.
  const usedAtStart = (1 - freemem() / totalmem()) * 100
  test.skip(usedAtStart < 52, `RAM in use is ${usedAtStart.toFixed(1)} % (< 52 %): the 50 % threshold cannot be crossed`)
  const { app, notch } = await launch()
  // The capsule rests in peek (time and date): the metrics show in compact, with the pointer on it.
  await showCompact(notch)
  const ram = notch.getByTestId('metric-ram')
  await expect(ram).toBeVisible({ timeout: 10_000 })
  await expect(ram).toHaveAttribute('data-alert', 'true', { timeout: 5000 })
  await expect(ram).toHaveClass(/text-fail/)
  await expect(notch.getByTestId('metric-cpu')).not.toHaveAttribute('data-alert', /.*/)

  await settle(notch)
  await notch.screenshot({ path: 'test-results/system-alerts-capsule-es.png' })
  await setLanguage(notch, 'en')
  await expect(ram).toHaveAttribute('aria-label', /^RAM /)
  await expect(ram).toHaveAttribute('data-alert', 'true')
  await settle(notch)
  await notch.screenshot({ path: 'test-results/system-alerts-capsule-en.png' })

  const cc = await openControlCenter(app, notch)
  await cc.getByRole('button', { name: /^(Sistema|System)$/ }).click()
  await expect(cc.getByTestId('system-alerts-page')).toBeVisible()
  const threshold = cc.getByRole('textbox', { name: /^(Umbral de RAM en %|RAM threshold in %)$/ })
  await expect(threshold).toHaveValue('50')
  await settle(cc)
  await cc.screenshot({ path: 'test-results/system-alerts-settings.png' })

  const usedPercent = (1 - freemem() / totalmem()) * 100
  await threshold.fill('99')
  await threshold.press('Enter')
  await expect(threshold).toHaveValue('99')
  if (usedPercent >= 94) {
    test.info().annotations.push({
      type: 'note',
      description: `RAM in use is ${usedPercent.toFixed(1)} % (>= 94 %, inside the 5-point hysteresis of 99): the recovery assertion did not run`,
    })
    return
  }
  await expect(ram).not.toHaveAttribute('data-alert', /.*/, { timeout: 5000 })
  await expect(ram).not.toHaveClass(/text-fail/)
})
