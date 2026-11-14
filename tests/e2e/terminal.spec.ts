import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { NotchApi } from '../../src/shared/ipc/api'

type NotchWindow = { notch: NotchApi; __firstTerminalData?: number }

let userData: string

const launch = async (): Promise<{ app: ElectronApplication; notch: Page; errors: string[] }> => {
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
  const notch = await app.firstWindow()
  const errors: string[] = []
  notch.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await notch.emulateMedia({ reducedMotion: 'reduce' })
  await expect(notch.getByTestId('notch-capsule')).toBeVisible()
  return { app, notch, errors }
}

/** Visible text of the terminal grid (xterm's DOM renderer). */
const screenText = (notch: Page) => notch.locator('.xterm-rows').innerText()

const openTerminal = async (notch: Page) => {
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.notch.request({ intent: 'expand' }))
  await notch.getByTestId('integration-terminal').click()
  await expect(notch.getByTestId('notch-capsule')).toHaveAttribute('data-mode', 'terminal')
  await expect(notch.getByTestId('terminal-view')).toHaveAttribute('data-status', 'running')
}

/** Types a command and waits until the shell has printed something that matches. */
const run = async (notch: Page, command: string, expected: RegExp, timeout = 15_000) => {
  await expect(notch.locator('.xterm-helper-textarea')).toBeFocused()
  await notch.keyboard.type(command)
  await notch.keyboard.press('Enter')
  await expect.poll(() => screenText(notch), { timeout }).toMatch(expected)
}

let marker = 0
/**
 * Waits until the shell runs commands again. Independent of the user's prompt (profiles such as
 * oh-my-posh change it): the typed text `'RD'+'Y<n>'` only prints `RDY<n>` once it really runs.
 */
const waitForPrompt = async (notch: Page) => {
  marker += 1
  await run(notch, `'RD'+'Y${marker}'`, new RegExp(`RDY${marker}`), 20_000)
}

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'notch-e2e-'))
})

test.afterEach(() => {
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('opens a real PowerShell from the integrations row in under 1 s', async () => {
  const { app, notch, errors } = await launch()
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.notch.request({ intent: 'expand' }))
  await expect(notch.getByTestId('integration-terminal')).toBeVisible()
  await notch.screenshot({ path: 'test-results/m2-terminal-home.png' })

  await notch.evaluate(() => {
    const win = globalThis as unknown as NotchWindow
    win.notch.events.on('terminal:data', () => {
      win.__firstTerminalData ??= performance.now()
    })
  })
  const clickedAt = await notch.evaluate(() => performance.now())
  await notch.getByTestId('integration-terminal').click()
  await expect(notch.locator('.xterm')).toBeVisible()
  await expect.poll(() => notch.evaluate(() => (globalThis as unknown as NotchWindow).__firstTerminalData)).toBeDefined()
  const firstOutput = await notch.evaluate(() => (globalThis as unknown as NotchWindow).__firstTerminalData!)
  console.log(`terminal first output after ${Math.round(firstOutput - clickedAt)} ms`)
  expect(firstOutput - clickedAt).toBeLessThan(1000)

  await waitForPrompt(notch)
  expect(errors.filter((e) => /Content Security Policy/i.test(e))).toEqual([])
  await app.close()
})

test('runs interactive commands and interrupts with Ctrl+C', async () => {
  const { app, notch } = await launch()
  await openTerminal(notch)
  await waitForPrompt(notch)

  await run(notch, 'Get-ChildItem -Name -Directory | Select-Object -First 50', /AppData|Desktop|Documents/)
  await run(notch, `Set-Location '${resolve('.')}'; 'git:' + (git rev-parse --is-inside-work-tree)`, /git:true/)
  await run(notch, 'ping -t 127.0.0.1', /127\.0\.0\.1.*(TTL|ttl)/)
  await notch.keyboard.press('Control+C')
  await expect.poll(() => screenText(notch)).toMatch(/Control-C|\^C/)
  // The console drops keystrokes sent in the same instant as Ctrl+C (as in Windows Terminal).
  await notch.waitForTimeout(500)
  await waitForPrompt(notch)
  await notch.screenshot({ path: 'test-results/m2-terminal-session.png' })
  await app.close()
})

test('keeps the session and its history when the panel closes', async () => {
  const { app, notch } = await launch()
  await openTerminal(notch)
  await waitForPrompt(notch)
  await run(notch, "$m = 'notch-' + 7; $m", /notch-7/)

  // The pointer (left on the capsule by the click) leaves it, or the capsule would stay in compact.
  await notch.mouse.move(1, 1)
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.notch.request({ intent: 'dismiss' }))
  await expect(notch.getByTestId('notch-capsule')).toHaveAttribute('data-mode', 'peek')

  // Reopening shows the integrations row; the same session is one click away.
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.notch.request({ intent: 'expand' }))
  await expect(notch.getByTestId('notch-capsule')).toHaveAttribute('data-mode', 'expanded')
  await notch.getByTestId('integration-terminal').click()
  await expect.poll(() => screenText(notch)).toMatch(/notch-7/)
  await run(notch, "$m + '-again'", /notch-7-again/)
  await app.close()
})

test('exit closes the terminal like a terminal window, and the next open starts a new shell', async () => {
  const { app, notch } = await launch()
  await openTerminal(notch)
  await waitForPrompt(notch)
  await run(notch, "$m = 'old-session'; $m", /old-session/)

  // The pointer (left on the terminal tile by the click) leaves the capsule, or it would close to compact.
  await notch.mouse.move(1, 1)
  await notch.keyboard.type('exit')
  await notch.keyboard.press('Enter')
  await expect(notch.getByTestId('notch-capsule')).toHaveAttribute('data-mode', 'peek')

  await openTerminal(notch)
  await waitForPrompt(notch)
  expect(await screenText(notch)).not.toMatch(/old-session/)
  await run(notch, "'new:' + [string]::IsNullOrEmpty($m)", /new:True/)
  await app.close()
})

test('Esc stays in the terminal and the back button returns to the row', async () => {
  const { app, notch } = await launch()
  await openTerminal(notch)
  await notch.keyboard.press('Escape')
  await expect(notch.getByTestId('notch-capsule')).toHaveAttribute('data-mode', 'terminal')

  await notch.getByRole('button', { name: /Volver|Back/ }).click()
  await expect(notch.getByTestId('notch-capsule')).toHaveAttribute('data-mode', 'expanded')
  await notch.keyboard.press('Escape')
  await expect(notch.getByTestId('notch-capsule')).toHaveAttribute('data-mode', 'peek')
  await app.close()
})

test('only the notch window can use the terminal channels', async () => {
  const { app, notch } = await launch()
  await openTerminal(notch)

  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.app.openControlCenter())
  const controlCenter = await app.waitForEvent('window', (page) => page.url().includes('control-center'))
  await controlCenter.waitForLoadState('domcontentloaded')
  const results = await controlCenter.evaluate(async () => {
    const api = (globalThis as unknown as NotchWindow).notch
    return Promise.all([api.terminal.input({ data: 'exit\r' }), api.terminal.open(), api.terminal.resize({ cols: 80, rows: 24 })])
  })
  for (const result of results) expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  await app.close()
})
