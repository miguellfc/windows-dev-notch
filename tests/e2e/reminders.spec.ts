import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { NotchApi } from '../../src/shared/ipc/api'

type NotchWindow = { notch: NotchApi }
type TestClockHost = { __notchTestClock: { advance: (ms: number) => Promise<void> } }

let userData: string
let launched: ElectronApplication | undefined

const DAY_MS = 24 * 60 * 60_000

const writeSettings = (): void => {
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({
      version: 2,
      language: 'es',
      shortcut: 'Control+Alt+Space',
      launchAtLogin: false,
      reminders: { snoozeMinutes: 10, sound: false },
    }),
    'utf8',
  )
}

const writeReminders = (reminders: { text: string; dueAt: Date }[]): void => {
  writeFileSync(
    join(userData, 'reminders.json'),
    JSON.stringify({
      version: 1,
      reminders: reminders.map(({ text, dueAt }) => ({
        id: randomUUID(),
        text,
        dueAt: dueAt.toISOString(),
        repeat: 'none',
        state: 'pending',
        createdAt: new Date(Date.now() - 2 * DAY_MS).toISOString(),
      })),
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
  env['NOTCH_TEST_CLOCK'] = '1'
  // Stay isolated from an installed notch and from the real ~/.claude/settings.json.
  env['NOTCH_CLAUDE_SETTINGS'] = join(userData, 'claude-settings.json')
  env['NOTCH_CLAUDE_PORT'] = '0'
  const app = await electron.launch({ args: ['.'], env })
  launched = app
  const notch = await app.firstWindow()
  await notch.emulateMedia({ reducedMotion: 'reduce' })
  await expect(notch.getByTestId('notch-capsule')).toBeVisible()
  return { app, notch }
}

const hhmm = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

const capsule = (notch: Page) => notch.getByTestId('notch-capsule')
const expand = (notch: Page) => notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.notch.request({ intent: 'expand' }))
const dismiss = (notch: Page) => notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.notch.request({ intent: 'dismiss' }))
const advance = (app: ElectronApplication, ms: number) =>
  app.evaluate(async (_electron, delta) => {
    await (globalThis as unknown as TestClockHost).__notchTestClock.advance(delta)
  }, ms)

const openControlCenter = async (app: ElectronApplication, notch: Page): Promise<Page> => {
  await notch.evaluate(() => (globalThis as unknown as NotchWindow).notch.app.openControlCenter())
  const cc = await app.waitForEvent('window', (page) => page.url().includes('control-center'))
  await cc.waitForLoadState('domcontentloaded')
  await cc.emulateMedia({ reducedMotion: 'reduce' })
  return cc
}

test.beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'notch-e2e-rem-'))
  writeSettings()
})

test.afterEach(async () => {
  await launched?.close().catch(() => undefined)
  launched = undefined
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('creates two reminders, raises the alert when due, then snoozes and completes them', async () => {
  const { app, notch } = await launch()

  await expand(notch)
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'expanded')
  const tile = notch.getByTestId('integration-reminders')
  await expect(tile).toBeVisible()
  await notch.waitForTimeout(600) // let the cross-fade finish
  await notch.screenshot({ path: 'test-results/m4-integration-row.png' })

  await tile.click()
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'reminders')
  await expect(notch.getByTestId('reminders-empty')).toBeVisible()
  const add = notch.getByTestId('reminders-add')
  await expect(add).toBeFocused()
  await notch.waitForTimeout(600)
  await notch.screenshot({ path: 'test-results/m4-empty.png' })

  const form = notch.getByTestId('reminder-form')
  const text = notch.getByTestId('reminder-form-text')
  const time = notch.getByTestId('reminder-form-time')
  const items = notch.getByTestId('reminder-item')

  // A one-off reminder 30 minutes from now (Mañana if that crosses midnight), saved with Enter.
  await add.click()
  await expect(text).toBeFocused()
  await expect(time).toHaveValue(/^([01]\d|2[0-3]):(00|15|30|45)$/)
  const inThirty = new Date(Date.now() + 30 * 60_000)
  if (inThirty.getDate() !== new Date().getDate()) await form.getByRole('radio', { name: 'Mañana' }).click()
  await text.fill('revisar PR')
  await time.fill(hhmm(inThirty))
  await notch.waitForTimeout(300)
  await notch.screenshot({ path: 'test-results/m4-form.png' })
  await time.press('Enter')
  await expect(form).toBeHidden()
  await expect(items).toHaveCount(1)

  // Validation stays inline: no text, then a bad time.
  await add.click()
  await notch.getByTestId('reminder-form-save').click()
  await expect(notch.getByTestId('reminder-form-text-error')).toHaveText('Escribe qué recordar')
  // Worst case for the panel height: Other day (date row) plus an inline error.
  await form.getByRole('radio', { name: 'Otro día' }).click()
  await expect(notch.getByTestId('reminder-form-date')).toBeVisible()
  await notch.waitForTimeout(300)
  await notch.screenshot({ path: 'test-results/m4-form-other-day.png' })
  await form.getByRole('radio', { name: 'Hoy' }).click()
  await text.fill('desplegar build')
  await time.fill('25:00')
  await notch.getByTestId('reminder-form-save').click()
  await expect(notch.getByTestId('reminder-form-time-error')).toHaveText('Hora no válida (HH:mm)')

  // A daily reminder 20 minutes from now: the Day field hides, the first occurrence is the next one.
  await form.getByRole('radio', { name: 'Cada día' }).click()
  await expect(form.getByRole('radiogroup', { name: 'Día' })).toBeHidden()
  await time.fill(hhmm(new Date(Date.now() + 20 * 60_000)))
  await notch.getByTestId('reminder-form-save').click()
  await expect(form).toBeHidden()
  await expect(items).toHaveCount(2)
  await expect(items.filter({ hasText: 'revisar PR' })).toHaveCount(1)
  await expect(items.filter({ hasText: 'desplegar build' })).toHaveCount(1)
  await expect(items.filter({ hasText: 'desplegar build' }).getByRole('img', { name: 'Se repite cada día' })).toBeVisible()

  // Esc in the form returns to the list, not to the integrations row.
  await add.click()
  await expect(text).toBeFocused()
  await text.press('Escape')
  await expect(form).toBeHidden()
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'reminders')
  await expect(add).toBeFocused()
  await notch.waitForTimeout(300)
  await notch.screenshot({ path: 'test-results/m4-list.png' })

  // Back to the compact capsule so the alert can take it over.
  await dismiss(notch)
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'compact')

  await advance(app, 31 * 60_000)
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'alert', { timeout: 1000 })
  const alert = notch.getByTestId('reminder-alert')
  await expect(alert).toBeVisible({ timeout: 1000 })
  await expect(alert).toContainText('2 recordatorios')
  await notch.waitForTimeout(600)
  await notch.screenshot({ path: 'test-results/m4-alert.png' })

  await expand(notch)
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'reminders')
  const due = items.filter({ has: notch.getByRole('button', { name: /Posponer/ }) })
  await expect(due).toHaveCount(2)
  await notch.waitForTimeout(600)
  await notch.screenshot({ path: 'test-results/m4-due-view.png' })

  // Snooze the first: it leaves the due list; the other one is still due.
  await due.first().getByRole('button', { name: /Posponer/ }).click()
  await expect(items.filter({ has: notch.getByRole('button', { name: /Posponer/ }) })).toHaveCount(1)
  // Complete the remaining one: nothing is due any more.
  await notch.getByRole('button', { name: 'Completar', exact: true }).click()
  await expect(notch.getByRole('button', { name: /Posponer/ })).toHaveCount(0)

  await dismiss(notch)
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'compact')
  await expect(notch.getByTestId('reminder-alert')).toBeHidden()
  await app.close()
})

test('a reminder that came due while the app was closed raises the missed alert at startup', async () => {
  writeReminders([{ text: 'llamar al banco', dueAt: new Date(Date.now() - DAY_MS) }])
  const { app, notch } = await launch()

  await expect(capsule(notch)).toHaveAttribute('data-mode', 'alert', { timeout: 5000 })
  await expect(notch.getByTestId('reminder-alert')).toContainText('llamar al banco')

  await expand(notch)
  await expect(capsule(notch)).toHaveAttribute('data-mode', 'reminders')
  const row = notch.getByTestId('reminder-item')
  await expect(row).toHaveAttribute('data-state', 'missed')
  await expect(row).toContainText('Perdido')
  await app.close()
})

test('Control Center rejects editing a reminder to a past date and keeps it unchanged', async () => {
  const future = new Date(Date.now() + DAY_MS)
  writeReminders([{ text: 'revisar informe', dueAt: future }])
  const { app, notch } = await launch()
  const cc = await openControlCenter(app, notch)

  await cc.getByRole('button', { name: 'Recordatorios' }).click()
  const item = cc.getByTestId('reminder-item')
  await expect(item).toContainText('revisar informe')
  await item.getByRole('button', { name: /Editar/ }).click()

  const when = cc.getByTestId('reminder-edit-when')
  await when.fill('2020-01-01T10:00')
  await cc.getByRole('button', { name: 'Guardar' }).click()
  await expect(cc.getByTestId('reminder-edit-when-error')).toHaveText('La fecha ya pasó')

  // The window is Mica (transparent page): give it the dark backdrop it shows on screen.
  await cc.addStyleTag({ content: 'html, body { background: #0d0d0f !important }' })
  await cc.waitForTimeout(1000)
  await cc.screenshot({ path: 'test-results/m4-control-center.png' })

  const saved = JSON.parse(readFileSync(join(userData, 'reminders.json'), 'utf8')) as { reminders: { dueAt: string }[] }
  expect(saved.reminders).toHaveLength(1)
  expect(new Date(saved.reminders[0]!.dueAt).getTime()).toBeGreaterThan(Date.now())
  await app.close()
})
