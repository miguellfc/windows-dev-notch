import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { CONFIRM_ARM_MS } from '../../src/renderer/notch/system/confirm-guard'
import type { NotchApi } from '../../src/shared/ipc/api'
import { PROCESS_LIMIT } from '../../src/shared/system/schema'
import { settle } from './settle'

type NotchWindow = { notch: NotchApi }

let userData: string
let settingsFile: string
let launched: ElectronApplication | undefined
let burner: ChildProcess | undefined

const launch = async (): Promise<{ app: ElectronApplication; notch: Page }> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RENDERER_URL') env[key] = value
  }
  env['NOTCH_USER_DATA_DIR'] = userData
  env['NOTCH_DISABLE_FOREGROUND_WATCH'] = '1'
  // Never touch the real ~/.claude/settings.json nor collide with an installed notch on 47600.
  env['NOTCH_CLAUDE_SETTINGS'] = settingsFile
  env['NOTCH_CLAUDE_PORT'] = '0'
  const app = await electron.launch({ args: ['.'], env })
  launched = app
  const notch = await app.firstWindow()
  await notch.emulateMedia({ reducedMotion: 'reduce' })
  await expect(notch.getByTestId('notch-capsule')).toBeVisible()
  return { app, notch }
}

const capsule = (notch: Page) => notch.getByTestId('notch-capsule')
const expand = (notch: Page) => notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.notch.request({ intent: 'expand' }))
const setLanguage = (notch: Page, language: 'es' | 'en') =>
  notch.evaluate((value) => (globalThis as unknown as NotchWindow).notch.settings.update({ language: value }), language)

const openSystem = async (notch: Page): Promise<void> => {
  await expand(notch)
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'expanded')
  await notch.getByRole('button', { name: /^(Sistema|System)$/ }).click()
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'system')
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A child of this test that spins one core. */
const spawnBurner = (): ChildProcess => {
  const child = spawn('node', ['-e', 'for(;;){}'], { stdio: 'ignore', windowsHide: true })
  burner = child
  return child
}

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'notch-e2e-'))
  settingsFile = join(userData, 'claude-settings.json')
})

test.afterEach(async () => {
  // Only the process this test spawned is ever killed.
  if (burner?.pid !== undefined && isAlive(burner.pid)) burner.kill()
  burner = undefined
  await launched?.close().catch(() => undefined)
  launched = undefined
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('the capsule shows CPU and RAM, in both languages', async () => {
  const { notch } = await launch()
  await expect(notch.getByTestId('capsule-metrics')).toBeVisible({ timeout: 10_000 })
  await expect(notch.getByTestId('metric-cpu')).toBeVisible()
  await expect(notch.getByTestId('metric-ram')).toBeVisible()
  // Battery only exists on laptops.
  console.log(`battery metric present: ${(await notch.getByTestId('metric-battery').count()) > 0}`)

  await setLanguage(notch, 'es')
  await expect(notch.getByTestId('metric-cpu')).toHaveAttribute('aria-label', /^CPU /)
  await settle(notch)
  await notch.screenshot({ path: 'test-results/system-capsule-es.png' })

  await setLanguage(notch, 'en')
  await expect(notch.getByTestId('metric-ram')).toHaveAttribute('aria-label', /^RAM /)
  await settle(notch)
  await notch.screenshot({ path: 'test-results/system-capsule-en.png' })
})

test('the System tile shows cards and processes in under 2 s', async () => {
  const { notch } = await launch()
  await setLanguage(notch, 'es')
  await expand(notch)
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'expanded')
  await notch.getByRole('button', { name: 'Sistema' }).click()
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'system')
  await expect(notch.getByTestId('system-card-cpu')).toBeVisible({ timeout: 2000 })
  await expect(notch.getByTestId('system-card-ram')).toBeVisible({ timeout: 2000 })
  await expect(notch.getByTestId('process-row').first()).toBeVisible({ timeout: 2000 })
  // The list is the top 5 (PROCESS_LIMIT): never more rows, and the panel (280 px) shows them without scrolling.
  await expect.poll(() => notch.getByTestId('process-row').count()).toBe(PROCESS_LIMIT)
  expect(await notch.getByTestId('process-list').evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true)
  // Main warms up before the first emission: the very first list already has CPU values, and the
  // network card has rates, instead of "—".
  // Read once (no auto-retry): the first emission itself must carry the values.
  expect(await notch.getByTestId('process-row').first().innerText()).not.toContain('—')
  expect(await notch.getByTestId('system-card-network').innerText()).not.toContain('—')
  await settle(notch)
  await notch.screenshot({ path: 'test-results/system-view.png' })
})

test('closes a busy process through the UI; a non-killable row (when listed) has no Close button', async () => {
  const child = spawnBurner()
  const pid = child.pid
  if (pid === undefined) throw new Error('could not spawn the busy process')
  const { notch } = await launch()
  await openSystem(notch)

  const row = notch.locator(`[data-testid="process-row"][data-pid="${pid}"]`)
  // The first CPU reading after opening is null; the second tick ranks the process (it must reach the top 5 by CPU).
  await expect(async () => {
    await expect(row).toBeVisible({ timeout: 1500 })
  }).toPass({ timeout: 10_000 })

  const rows = notch.getByTestId('process-row')
  const total = await rows.count()
  expect(total).toBeLessThanOrEqual(PROCESS_LIMIT)
  let nonKillableRow: Locator | undefined
  for (let i = 0; i < total; i++) {
    const candidate = rows.nth(i)
    if ((await candidate.getByTestId('process-close').count()) === 0) {
      nonKillableRow = candidate
      break
    }
  }
  if (nonKillableRow) {
    await expect(nonKillableRow.getByTestId('process-close')).toHaveCount(0)
  } else {
    test.info().annotations.push({
      type: 'note',
      description: `no non-killable row among the ${total} listed processes; the no-Close-button assertion did not run`,
    })
  }

  await row.hover()
  await row.getByTestId('process-close').click()
  const confirm = notch.getByTestId('process-confirm')
  await expect(confirm).toBeVisible()
  await expect(confirm).toContainText(String(pid))
  await settle(notch)
  await notch.screenshot({ path: 'test-results/system-confirm.png' })

  // Esc cancels the question and keeps the view.
  await notch.keyboard.press('Escape')
  await expect(confirm).toBeHidden()
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'system')
  expect(isAlive(pid)).toBe(true)

  // A double-click on Close must not terminate. By design the confirm row puts Cancel under the
  // same spot as the ✕, so the second click of the pair cancels the question.
  await row.hover()
  await row.getByTestId('process-close').dblclick()
  await expect(confirm).toBeHidden()
  expect(isAlive(pid)).toBe(true)
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'system')

  // The 300 ms guard itself: activating the confirm button right after the question opens is ignored.
  await row.hover()
  await row.getByTestId('process-close').click()
  await expect(confirm).toBeVisible()
  await notch.getByTestId('process-confirm-close').dispatchEvent('click')
  expect(isAlive(pid)).toBe(true)
  await expect(confirm).toBeVisible()

  // This wait must stay above the renderer's CONFIRM_ARM_MS (300 ms) guard, or the click is ignored.
  await notch.waitForTimeout(CONFIRM_ARM_MS + 100)
  await notch.getByTestId('process-confirm-close').click()
  await expect.poll(() => isAlive(pid), { timeout: 5000 }).toBe(false)
  await expect(notch.locator(`[data-pid="${pid}"]`)).toHaveCount(0, { timeout: 5000 })
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'system')
})

test('idle cost in compact stays under 0.5 % CPU', async () => {
  test.setTimeout(150_000)
  const { app, notch } = await launch()
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'compact')
  await expect(notch.getByTestId('metric-cpu')).toBeVisible({ timeout: 10_000 })
  const SAMPLES = 12
  const readings: number[] = []
  for (let i = 0; i < SAMPLES; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5000))
    const total = await app.evaluate(({ app: electronApp }) =>
      electronApp.getAppMetrics().reduce((sum, metric) => sum + metric.cpu.percentCPUUsage, 0),
    )
    readings.push(total)
  }
  // The first sample is a warm-up (startup work, first metrics tick); it is discarded.
  const totals = readings.slice(1)
  const mean = totals.reduce((a, b) => a + b, 0) / totals.length
  console.log(`idle CPU (compact, ${SAMPLES} samples, first discarded): mean ${mean.toFixed(3)} %, samples ${totals.map((v) => v.toFixed(2)).join(' ')}`)
  expect(mean).toBeLessThan(0.5)
})

test('a process row shows its Close button on hover or keyboard focus only', async () => {
  const { notch } = await launch()
  await openSystem(notch)
  const rows = notch.getByTestId('process-row').filter({ has: notch.getByTestId('process-close') })
  await expect(async () => {
    await expect(rows.first()).toBeVisible({ timeout: 1500 })
  }).toPass({ timeout: 10_000 })
  const row = rows.first()
  const close = row.getByTestId('process-close')

  await row.hover()
  await expect(close).toHaveCSS('opacity', '1')
  // Script focus after pointer use is not keyboard focus: it must not pin the button.
  await close.evaluate((button) => (button as unknown as { focus: () => void }).focus())
  await notch.mouse.move(1, 1)
  await expect(close).toHaveCSS('opacity', '0')

  // Keyboard focus reveals it with no hover.
  await close.focus()
  await notch.keyboard.press('Shift+Tab')
  await notch.keyboard.press('Tab')
  await expect(close).toBeFocused()
  await expect(close).toHaveCSS('opacity', '1')
})
